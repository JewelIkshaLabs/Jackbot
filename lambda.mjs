// index.mjs
import fetch from 'node-fetch';
import { WebClient } from "@slack/web-api";
import dotenv from "dotenv";
import OpenAI from "openai";
import { OPENAI_PROMPT } from "./constant.js";

// Load environment variables from .env file (only in local development, not in Lambda)
if (typeof process.env.AWS_LAMBDA_FUNCTION_NAME === 'undefined') {
  dotenv.config();
}

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

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

const jiraAuthHeader =
  `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`;

// In-memory cache to prevent duplicate event processing
// Key format: channel_timestamp_event_ts
const processedEvents = new Set();

const logAndSendResponse = (response) => {
  console.log("Sending a response -")
  console.log(response)
  return response
}


/**
 * Create an ADF document with a hyperlink to the Slack message.
 * @param {string} summary - The summary text
 * @param {string} originalText - The original Slack message text
 * @param {string} slackPermalink - The Slack message permalink URL
 * @returns {Object} ADF document object
 */
function createDescriptionADF(summary, originalText, slackPermalink) {
  const content = [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Created automatically from Slack message." }
      ]
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: summary, marks: [{ type: "strong" }] }
      ]
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Original message:" }
      ]
    }
  ];

  // Handle multi-line original text by splitting into paragraphs
  const textLines = String(originalText || "").split(/\r?\n/);
  textLines.forEach((line) => {
    if (line.trim().length > 0) {
      content.push({
        type: "paragraph",
        content: [{ type: "text", text: line }]
      });
    } else {
      content.push({
        type: "paragraph",
        content: []
      });
    }
  });

  // Add the Slack link
  content.push(
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "View in Slack",
          marks: [
            {
              type: "link",
              attrs: {
                href: slackPermalink
              }
            },
            { type: "strong" }
          ]
        }
      ]
    }
  );
  
  return { type: "doc", version: 1, content };
}

/**
 * Call OpenAI API to generate a concise Jira title and summary.
 * @param {string} text - The Slack message text
 * @returns {Promise<{title: string, summary: string}>} Object with title and summary
 */
async function generateJiraTicketContent(text) {
  if (!openai) {
    console.warn("OpenAI API key not configured, using fallback");
    // Fallback: use truncated text as title and full text as summary
    const title = text.length > 100 ? text.slice(0, 97) + "..." : text;
    const summary = text;
    return { title, summary };
  }

  try {
    const prompt = OPENAI_PROMPT.replace("{text}", text);
    
    const response = await openai.chat.completions.create({
      model: "gpt-5.1",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that generates Jira ticket titles and summaries. Always respond with valid JSON only."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_completion_tokens: 300
    });
    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content in OpenAI response");
    }

    const parsed = JSON.parse(content);
    
    // Validate and sanitize
    const title = (parsed.title || text.slice(0, 100)).trim();
    const summary = (parsed.summary || text).trim();
    
    // Ensure title doesn't exceed Jira's limit (255 chars, but we'll use 100 for conciseness)
    const finalTitle = title.length > 100 ? title.slice(0, 97) + "..." : title;
    
    return { title: finalTitle, summary };
  } catch (error) {
    console.error("OpenAI API error:", error);
    // Fallback: use truncated text as title and full text as summary
    const title = text.length > 100 ? text.slice(0, 97) + "..." : text;
    const summary = text;
    return { title, summary };
  }
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

/**
 * Process the Slack event asynchronously after acknowledging receipt
 */
async function processEventAsync(slackEvent, body, channel, ts, currentEventText) {
  try {
    // Check if this is a thread reply and fetch parent message if needed
    const parentMessage = await getParentMessageIfThreadReply(slackEvent);
    
    // Use parent message text if it exists, otherwise use current event text
    const text = parentMessage ? getCleanSlackText(parentMessage) : currentEventText;

    if (body?.type === 'event_callback' && body.event?.type && body.event.type !== 'app_mention') {
      // Not an app_mention - ignore
      console.log('Ignored non-app_mention event');
      return;
    }

    if (!channel || !ts) {
      console.error("Missing channel or ts");
      return;
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

    // 2️⃣ Generate Jira ticket title and summary using OpenAI
    const { title, summary } = await generateJiraTicketContent(text);

    // 3️⃣ Build description in ADF format with hyperlink
    const descriptionADF = createDescriptionADF(summary, text, slackPermalink);

    const jiraPayload = {
      fields: {
        project: { key: JIRA_PROJECT_KEY },
        summary: title,
        // IMPORTANT: description is an ADF object (not a plain string)
        description: descriptionADF,
        issuetype: { name: JIRA_ISSUE_TYPE },
        labels: JIRA_LABELS,
      },
    };

    // 4️⃣ Create Jira Issue
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
      return;
    }

    const issueKey = jiraJson.key;
    const issueUrl = `${JIRA_BASE_URL}/browse/${issueKey}`;

    // 4.5️⃣ Handle Slack file attachments
    // Collect files from both current event and parent message (if thread reply)
    const slackFiles = [];
    if (slackEvent.files && slackEvent.files.length > 0) {
      slackFiles.push(...slackEvent.files);
    }
    if (parentMessage && parentMessage.files && parentMessage.files.length > 0) {
      slackFiles.push(...parentMessage.files);
    }
    
    if (slackFiles.length > 0) {
      console.log("Found Slack attachments:", slackFiles.map(f => ({ name: f.name, mimetype: f.mimetype, size: f.size })));
      
      for (const file of slackFiles) {
        try {
          if (!file.id) {
            console.error(`Downloading Slack file failed: File ${file.name || 'unnamed'} missing file ID`);
            continue;
          }
          
          // Get file info from Slack API to get download URL
          const fileInfo = await slackClient.files.info({
            file: file.id
          });
          
          if (!fileInfo.file) {
            console.error(`Downloading Slack file failed: No file info returned for ${file.name || 'unnamed'}`);
            continue;
          }
          
          // Get the download URL from file info
          const downloadUrl = fileInfo.file.url_private_download || fileInfo.file.url_private;
          if (!downloadUrl) {
            console.error(`Downloading Slack file failed: No download URL for ${file.name || 'unnamed'}`);
            continue;
          }
          
          // Download file from Slack
          const fileResponse = await fetch(downloadUrl, {
            headers: { 
              Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            }
          });
          
          if (!fileResponse.ok) {
            const errorDetails = `${fileResponse.status} ${fileResponse.statusText}`;
            console.error(`Downloading Slack file failed: ${errorDetails} for file ${file.name || 'unnamed'}`);
            continue;
          }
          
          // Read file as buffer
          const arrayBuffer = await fileResponse.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const fileContentType = fileResponse.headers.get('content-type') || file.mimetype || 'application/octet-stream';
          
          if (buffer.length === 0) {
            console.error(`Downloading Slack file failed: File ${file.name || 'unnamed'} is empty`);
            continue;
          }
          
          // Upload to Jira using multipart/form-data
          const boundary = `----JiraFormBoundary${Date.now()}${Math.random().toString(36).substring(2, 9)}`;
          const CRLF = '\r\n';
          const filename = file.name || 'attachment';
          
          // Build multipart body
          const parts = [];
          parts.push(Buffer.from(`--${boundary}${CRLF}`, 'ascii'));
          parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename.replace(/"/g, '\\"')}"${CRLF}`, 'utf8'));
          parts.push(Buffer.from(`Content-Type: ${fileContentType}${CRLF}`, 'utf8'));
          parts.push(Buffer.from(CRLF, 'ascii'));
          parts.push(buffer);
          parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'ascii'));
          
          const multipartBody = Buffer.concat(parts);
          
          const attachmentResponse = await fetch(
            `${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/attachments`,
            {
              method: "POST",
              headers: {
                Authorization: jiraAuthHeader,
                "X-Atlassian-Token": "no-check",
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
              },
              body: multipartBody,
            }
          );
          
          if (!attachmentResponse.ok) {
            const errorText = await attachmentResponse.text();
            const errorDetails = `${attachmentResponse.status} ${attachmentResponse.statusText} - ${errorText}`;
            console.error(`Uploading attachment to Jira failed: ${errorDetails} for file ${file.name || 'unnamed'}`);
            continue;
          }
          
          await attachmentResponse.json();
          console.log(`Uploaded attachment to Jira: ${file.name || 'unnamed'}`);
        } catch (error) {
          const errorDetails = error.message || String(error);
          console.error(`Failed to process attachment ${file.name || 'unnamed'}: ${errorDetails}`);
        }
      }
    }

    // 5️⃣ Reply in Slack thread with the Jira link
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

    console.log(`Successfully created Jira issue: ${issueKey}`);
  } catch (err) {
    console.error("Error processing event asynchronously:", err);
  }
}

export const handler = async (event) => {
  try {
    const body =
      typeof event.body === "string" ? JSON.parse(event.body) : event.body;

    // Slack challenge (required one time when enabling Events API)
    if (body?.type === "url_verification") {
      return logAndSendResponse({
        statusCode: 200,
        headers: { "Content-Type": "text/plain" },
        body: body.challenge,
      });
    }

    const slackEvent = body?.event ?? body;
    
    // Deduplication: Check if we've already processed this event
    // Use channel + timestamp + event_ts to create unique key
    const eventKey = `${slackEvent.channel}_${slackEvent.ts}_${body.event_ts || slackEvent.event_ts || slackEvent.ts}`;
    
    if (processedEvents.has(eventKey)) {
      console.log("Duplicate event detected, skipping:", eventKey);
      return logAndSendResponse({ 
        statusCode: 200, 
        body: JSON.stringify({ ok: true, message: "Event already processed" }) 
      });
    }
    
    // Mark event as processed
    processedEvents.add(eventKey);
    
    // Clean up old entries periodically (keep last 1000 events)
    if (processedEvents.size > 1000) {
      const firstKey = processedEvents.values().next().value;
      processedEvents.delete(firstKey);
    }
    
    // CRITICAL: Respond to Slack immediately to prevent retries
    // Slack expects a response within 3 seconds, otherwise it retries the event
    // Process everything asynchronously after responding
    const channel = slackEvent.channel;
    const ts = slackEvent.ts;
    const currentEventText = getCleanSlackText(slackEvent);
    
    // Quick validation - if no "create a ticket", respond immediately
    if (!currentEventText.toLowerCase().includes('create a ticket')) {
      return logAndSendResponse({ 
        statusCode: 200, 
        body: JSON.stringify({ ok: true, message: "No operations required" }) 
      });
    }
    
    // Send immediate acknowledgment to Slack (within 3 seconds)
    const response = logAndSendResponse({ 
      statusCode: 200, 
      body: JSON.stringify({ ok: true, message: "Event received, processing..." }) 
    });
    
    // Process everything asynchronously (don't await - this prevents Slack retries)
    processEventAsync(slackEvent, body, channel, ts, currentEventText).catch(err => {
      console.error("Error processing event asynchronously:", err);
    });
    
    return response;
  } catch (err) {
    console.error("Lambda error:", err);
    return logAndSendResponse({
      statusCode: 500,
      body: "Internal Server Error",
    });
  }
};
