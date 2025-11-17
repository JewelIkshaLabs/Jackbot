// index.mjs
import fetch from 'node-fetch';
import { WebClient } from "@slack/web-api";

// Jira config
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// Jira issue defaults
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY;
const JIRA_ISSUE_TYPE = process.env.JIRA_ISSUE_TYPE;
const JIRA_LABELS = process.env.JIRA_LABELS ? process.env.JIRA_LABELS.split(',') : ["from-slack", "incoming-ticket"];

// Slack
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const slackClient = new WebClient(SLACK_BOT_TOKEN);

const jiraAuthHeader =
  `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`;


const logAndSendResponse = (response) => {
  console.log("Sending a response -")
  console.log(response)
  return response
}

/**
 * Convert a plain text string into a minimal Atlassian Document Format (ADF) object.
 * Splits input on newlines and converts each line into a paragraph node.
 */
function textToADF(text) {
  const paragraphs = String(text || "").split(/\r?\n/);
  const content = paragraphs.map((p) => {
    // If paragraph is empty, keep an empty paragraph node
    if (p.length === 0) {
      return { type: "paragraph", content: [] };
    }
    // Otherwise, single text node inside paragraph
    return { type: "paragraph", content: [{ type: "text", text: p }] };
  });
  return { type: "doc", version: 1, content };
}

function getCleanSlackText(event) {
  if (!event.blocks) return event.text || "";

  let result = "";

  for (const block of event.blocks) {
    if (block.type !== "rich_text") continue;

    for (const element of block.elements || []) {
      if (element.type !== "rich_text_section") continue;

      for (const item of element.elements || []) {
        if (item.type === "text") {
          result += item.text; // only user-written text
        }
      }
    }
  }

  return result.trim();
}

/**
 * Check if the message is a thread reply and fetch the parent message if it is.
 * @param {Object} evt - The Slack event object
 * @returns {Promise<Object|null>} The parent message if it's a thread reply, null otherwise
 */
async function getParentMessageIfThreadReply(evt) {
  // Check if the message is a thread reply
  if (evt.thread_ts && evt.thread_ts !== evt.ts) {
    console.log("Fetching parent message…");
    
    const response = await slackClient.conversations.replies({
      channel: evt.channel,
      ts: evt.thread_ts
    });
    
    const parentMessage = response.messages?.[0];
    console.log("Parent message text:", parentMessage?.text);
    
    return parentMessage;
  }
  
  return null;
}


export const handler = async (event) => {
  try {
    const body =
      typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      // console.log("Event Block (expanded):", JSON.stringify(body, null, 2));


    // Slack challenge (required one time when enabling Events API)
    if (body?.type === "url_verification") {
      return logAndSendResponse({
        statusCode: 200,
        headers: { "Content-Type": "text/plain" },
        body: body.challenge,
      });
    }

    const slackEvent = body?.event ?? body;
    
    // Check if this is a thread reply and fetch parent message if needed
    const parentMessage = await getParentMessageIfThreadReply(slackEvent);
    
    const currentEventText = getCleanSlackText(slackEvent);
    const channel = slackEvent.channel;
    const ts = slackEvent.ts;

    // Check current event for "create a ticket" to determine if we should proceed
    if (!currentEventText.toLowerCase().includes('create a ticket')) {
      return logAndSendResponse({ statusCode: 201, body: "No operations requried" })
    }
    
    // Use parent message text if it exists, otherwise use current event text
    const text = parentMessage ? getCleanSlackText(parentMessage) : currentEventText;

    if (body?.type === 'event_callback' && body.event?.type && body.event.type !== 'app_mention') {
      // Not an app_mention - ignore
      return logAndSendResponse({ statusCode: 200, body: 'Ignored non-app_mention event' });
    }

    if (!channel || !ts) {
      return logAndSendResponse({ statusCode: 400, body: "Missing channel or ts" })
    }

    // Always reply in the thread of the original message
    const thread_ts = slackEvent.thread_ts ?? ts;

    // 1️⃣ Get permalink for the Slack message
    const permalinkResp = await fetch(
      `https://slack.com/api/chat.getPermalink?channel=${channel}&message_ts=${ts}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      }
    );

    const permalinkJson = await permalinkResp.json();
    const slackPermalink =
      permalinkJson?.ok
        ? permalinkJson.permalink
        : `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;

    // 2️⃣ Prepare Jira issue payload WITH LABELS
    const summary =
      text.length > 120 ? text.slice(0, 117) + "..." : text;

    // build a plain description string (human readable) then convert to ADF
    const descriptionPlain = `Created automatically from Slack message:

${text}

Slack Message Link:
${slackPermalink}`;

    const descriptionADF = textToADF(descriptionPlain);

    const jiraPayload = {
      fields: {
        project: { key: JIRA_PROJECT_KEY },
        summary,
        // IMPORTANT: description is an ADF object (not a plain string)
        description: descriptionADF,
        issuetype: { name: JIRA_ISSUE_TYPE },
        labels: JIRA_LABELS,
      },
    };

    // 3️⃣ Create Jira Issue
    const jiraResp = await fetch(
      `${JIRA_BASE_URL}/rest/api/3/issue`,
      {
        method: "POST",
        headers: {
          Authorization: jiraAuthHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(jiraPayload),
      }
    );

    const jiraJson = await jiraResp.json();

    if (!jiraResp.ok) {
      console.error("Jira error:", jiraJson);
      return logAndSendResponse({
        statusCode: 500,
        body: `Failed to create Jira issue: ${JSON.stringify(jiraJson)}`,
      });
    }

    const issueKey = jiraJson.key;
    const issueUrl = `${JIRA_BASE_URL}/browse/${issueKey}`;

    // 4️⃣ Reply in Slack thread with the Jira link
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel,
        thread_ts,
        text: `:white_check_mark: Hello, you can track the issue here: <${issueUrl}|${issueKey}>`,
        mrkdwn: true,
      }),
    });

    return logAndSendResponse({
      statusCode: 200,
      body: JSON.stringify({ ok: true, issueKey }),
    });
  } catch (err) {
    console.error("Lambda error:", err);
    return logAndSendResponse({
      statusCode: 500,
      body: "Internal Server Error",
    });
  }
};