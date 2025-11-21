import fetch from 'node-fetch';
import FormData from 'form-data';
import OpenAI from 'openai';

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_USER = process.env.JIRA_USER || process.env.JIRA_EMAIL; // Support both JIRA_USER and JIRA_EMAIL
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'PROJ';
const JIRA_ISSUE_TYPE = process.env.JIRA_ISSUE_TYPE || 'Task';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

const jiraAuthHeader = `Basic ${Buffer.from(`${JIRA_USER}:${JIRA_API_TOKEN}`).toString('base64')}`;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Convert Markdown to Atlassian Document Format (ADF)
 * Supports: ## headings, **bold**, `inline code`, ```code blocks```, bullet lists, numbered lists
 * Convert markdown text to Atlassian Document Format (ADF)
 * Supports: headings, bold, inline code, code blocks, bullet lists
 */
function textToADF(text) {
  if (!text) return { type: 'doc', version: 1, content: [] };
  
  const content = [];
  const lines = String(text).split(/\r?\n/);

  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockContent = [];
  let inBulletList = false;
  let bulletItems = [];
  let inNumberedList = false;
  let numberedItems = [];

  const flushBulletList = () => {
    if (bulletItems.length > 0) {
      content.push({
        type: 'bulletList',
        content: bulletItems.map(item => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: item }]
        }))
      });
      bulletItems = [];
      inBulletList = false;
    }
  };

  const flushNumberedList = () => {
    if (numberedItems.length > 0) {
      content.push({
        type: 'orderedList',
        content: numberedItems.map(item => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: item }]
        }))
      });
      numberedItems = [];
      inNumberedList = false;
    }
  };

  const parseInlineFormatting = (text) => {
    const result = [];
    let remaining = text;
    
    // Parse **bold** and `inline code`
    const regex = /(\*\*([^*]+?)\*\*)|(`([^`]+?)`)/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(remaining)) !== null) {
      // Add text before match
      if (match.index > lastIndex) {
        result.push({
          type: 'text',
          text: remaining.substring(lastIndex, match.index)
        });
      }

      if (match[2]) {
        // Bold **...**
        result.push({
          type: 'text',
          text: match[2],
          marks: [{ type: 'strong' }]
        });
      } else if (match[4]) {
        // Inline code `...`
        result.push({
          type: 'text',
          text: match[4],
          marks: [{ type: 'code' }]
        });
      }
      lastIndex = regex.lastIndex;
    }

    // Add remaining text
    if (lastIndex < remaining.length) {
      result.push({
        type: 'text',
        text: remaining.substring(lastIndex)
      });
    }

    return result.length > 0 ? result : [{ type: 'text', text: text }];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Handle code blocks ```language ... ```
    const codeBlockMatch = line.match(/^```(\w*)?\s*$/);
    
  let bulletListItems = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Handle code blocks (```language or ```)
    const codeBlockMatch = line.match(/^```(\w*)\s*$/);
    if (codeBlockMatch) {
      // Close any open bullet list first
      if (inBulletList) {
        content.push({
          type: 'bulletList',
          content: bulletListItems,
        });
        bulletListItems = [];
        inBulletList = false;
      }
      
      if (inCodeBlock) {
        // End of code block
        content.push({
          type: 'codeBlock',
          attrs: { language: codeBlockLang || 'plain' },
          content: [{ type: 'text', text: codeBlockContent.join('\n') }],
        });
        codeBlockContent = [];
        inCodeBlock = false;
        codeBlockLang = '';
      } else {
        // Start of code block
        flushBulletList();
        flushNumberedList();
        inCodeBlock = true;
        codeBlockLang = codeBlockMatch[1] || 'plain';
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Handle markdown headings (## or ###)
    const headingMatch = line.match(/^(#{2,3})\s+(.*)$/);
    
    // Handle bullet list items (lines starting with "- ")
    const bulletMatch = line.match(/^-\s+(.*)$/);
    if (bulletMatch) {
      const itemText = bulletMatch[1].trim();
      const itemContent = parseInlineFormatting(itemText);
      
      bulletListItems.push({
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: itemContent,
          },
        ],
      });
      inBulletList = true;
      continue;
    } else if (inBulletList && line.trim() === '') {
      // Empty line closes the bullet list
      content.push({
        type: 'bulletList',
        content: bulletListItems,
      });
      bulletListItems = [];
      inBulletList = false;
      continue;
    } else if (inBulletList) {
      // Non-bullet line closes the bullet list
      content.push({
        type: 'bulletList',
        content: bulletListItems,
      });
      bulletListItems = [];
      inBulletList = false;
    }

    // Handle headings (## Heading)
    const headingMatch = line.match(/^(#+)\s+(.*)$/);
    if (headingMatch) {
      flushBulletList();
      flushNumberedList();
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      content.push({
        type: 'heading',
        attrs: { level: level },
        content: [{ type: 'text', text: text.trim() }],
      });
      continue;
    }

    // Handle bullet lists (- item)
    const bulletMatch = line.match(/^-\s+(.*)$/);
    if (bulletMatch) {
      if (inNumberedList) flushNumberedList();
      inBulletList = true;
      bulletItems.push(parseInlineFormatting(bulletMatch[1]));
      continue;
    }

    // Handle numbered lists (1. item, 2. item, etc)
    const numberedMatch = line.match(/^\d+\.\s+(.*)$/);
    if (numberedMatch) {
      if (inBulletList) flushBulletList();
      inNumberedList = true;
      numberedItems.push(parseInlineFormatting(numberedMatch[1]));
      continue;
    }

    // Handle horizontal rule (---)
    if (line.match(/^-{3,}$/)) {
      flushBulletList();
      flushNumberedList();
      content.push({ type: 'rule' });
      continue;
    }
    // Handle paragraphs with bold (**text**), inline code (`code`), and links [text](url)
    const paragraphContent = parseInlineFormatting(line);

    // Empty line
    if (line.trim().length === 0) {
      // Flush lists on empty line
      if (inBulletList) flushBulletList();
      if (inNumberedList) flushNumberedList();
      // Don't add empty paragraphs
      continue;
    }

    // Regular paragraph with inline formatting
    flushBulletList();
    flushNumberedList();
    const paragraphContent = parseInlineFormatting(line);
    content.push({ type: 'paragraph', content: paragraphContent });
  }

  // Close any unclosed bullet list
  if (inBulletList && bulletListItems.length > 0) {
    content.push({
      type: 'bulletList',
      content: bulletListItems,
    });
  }

  // Close any unclosed code block
  if (inCodeBlock && codeBlockContent.length > 0) {
    content.push({
      type: 'codeBlock',
      attrs: { language: codeBlockLang || 'plain' },
      content: [{ type: 'text', text: codeBlockContent.join('\n') }],
    });
  }

  // Flush any remaining lists
  flushBulletList();
  flushNumberedList();

  return { type: 'doc', version: 1, content };
}

/**
 * Parse inline formatting (bold, code, links) in text
 */
function parseInlineFormatting(text) {
  const content = [];
  let remainingText = text;

  // Regex to find bold (**text**), inline code (`code`), or markdown links [text](url)
  const regex = /(\*\*([^*]+?)\*\*)|(`([^`]+?)`)|(\[([^\]]+?)\]\(([^)]+?)\))/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(remainingText)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      content.push({ 
        type: 'text', 
        text: remainingText.substring(lastIndex, match.index) 
      });
    }

    if (match[2]) { 
      // Bold match
      content.push({ 
        type: 'text', 
        text: match[2], 
        marks: [{ type: 'strong' }] 
      });
    } else if (match[4]) { 
      // Inline code match
      content.push({ 
        type: 'text', 
        text: match[4], 
        marks: [{ type: 'code' }] 
      });
    } else if (match[6] && match[7]) {
      // Markdown link match [text](url)
      content.push({
        type: 'text',
        text: match[6],
        marks: [
          {
            type: 'link',
            attrs: {
              href: match[7],
            },
          },
        ],
      });
    }
    lastIndex = regex.lastIndex;
  }

  // Add any remaining text after the last match
  if (lastIndex < remainingText.length) {
    content.push({ 
      type: 'text', 
      text: remainingText.substring(lastIndex) 
    });
  }

  // If no content, add the full text as-is
  if (content.length === 0 && text.length > 0) {
    content.push({ type: 'text', text: text });
  }

  return content;
}

/**
 * Get Slack message permalink
 */
async function getSlackPermalink(channel, messageTs, workflowId = 'unknown') {
  if (!SLACK_BOT_TOKEN) {
    console.warn(`   [${workflowId}] SLACK_BOT_TOKEN not set - cannot get permalink`);
    return null;
  }

  try {
    const response = await fetch(
      `https://slack.com/api/chat.getPermalink?channel=${channel}&message_ts=${messageTs}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      }
    );

    const json = await response.json();
    if (json?.ok && json.permalink) {
      return json.permalink;
    }

    // Fallback: construct permalink manually
    return `https://slack.com/archives/${channel}/p${messageTs.replace('.', '')}`;
  } catch (error) {
    console.warn(`   [${workflowId}] Failed to get Slack permalink:`, error.message);
    // Fallback: construct permalink manually
    return `https://slack.com/archives/${channel}/p${messageTs.replace('.', '')}`;
  }
}

/**
 * OpenAI prompt for generating Jira ticket title and summary
 */
export const OPENAI_PROMPT = `You are a Jira ticket creation assistant. Based on the following Slack message text, generate a concise and professional Jira ticket.

Requirements:
- Title: Must be concise (max 30 characters), clear, and action-oriented. Focus on the main issue or request.
- Summary: Must be a brief description (2-3 sentences) that provides context and explains what needs to be done or what the issue is.
- Acceptance Criteria: Must be a clear list of 3-5 specific, measurable criteria that define when the issue is resolved. Format as bullet points.

The Slack message text is:
{text}

Respond with a JSON object in this exact format:
{
  "title": "Concise Jira ticket title here",
  "summary": "Brief summary description here",
  "acceptance_criteria": "- Criterion 1\n- Criterion 2\n- Criterion 3"
}`;

/**
 * Generate concise Jira title and summary using OpenAI
 */
async function generateJiraTitleAndSummary(text, workflowId = 'unknown') {
  if (!process.env.OPENAI_API_KEY) {
    console.warn(`   [${workflowId}] OPENAI_API_KEY not set - using fallback title/summary`);
    const fallbackTitle = text.length > 30 ? text.substring(0, 27) + '...' : text;
    return {
      title: fallbackTitle,
      summary: `Issue: ${text}\n\nReported from Slack.`,
      acceptanceCriteria: '- Issue is resolved\n- Solution is tested\n- Changes are documented',
    };
  }

  // Replace {text} placeholder with actual text
  const prompt = OPENAI_PROMPT.replace('{text}', text);

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a professional Jira ticket creation assistant. Always respond with valid JSON containing "title", "summary", and "acceptance_criteria" fields.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response from OpenAI');
    }

    const parsed = JSON.parse(content);
    
    // Validate and ensure title is within limits (max 30 characters as per prompt)
    let title = parsed.title || text.substring(0, 27) + '...';

    // Summary can be longer, but ensure it's reasonable for Jira description
    const summary = parsed.summary || `Issue: ${text}\n\nReported from Slack.`;
    
    // Acceptance criteria with fallback
    const acceptanceCriteria = parsed.acceptance_criteria || '- Issue is resolved\n- Solution is tested\n- Changes are documented';

    console.log(`   [${workflowId}] Generated Jira title: ${title}`);
    console.log(`   [${workflowId}] Generated acceptance criteria with ${acceptanceCriteria.split('\n').length} items`);
    return { title, summary, acceptanceCriteria };
  } catch (error) {
    console.error(`   [${workflowId}] OpenAI API error:`, error.message);
    // Fallback to original text
    const fallbackTitle = text.length > 30 ? text.substring(0, 27) + '...' : text;
    return {
      title: fallbackTitle,
      summary: `Issue: ${text}\n\nReported from Slack.`,
      acceptanceCriteria: '- Issue is resolved\n- Solution is tested\n- Changes are documented',
    };
  }
}

/**
 * Create a Jira ticket
 */
export async function createJiraTicket({ summary, description, githubRepo, issueDescription, slackMessage, slackChannel, slackMessageTs }, workflowId = 'unknown') {
  if (!JIRA_BASE_URL || !JIRA_USER || !JIRA_API_TOKEN) {
    throw new Error('Jira credentials not configured');
  }
  
  console.log(`   [${workflowId}] Creating ticket in project: ${JIRA_PROJECT_KEY}`);
  console.log(`   [${workflowId}] Issue type: ${JIRA_ISSUE_TYPE}`);

  // Generate Jira title and summary using OpenAI
  const inputText = issueDescription || slackMessage || description || summary || 'Issue reported from Slack';
  console.log(`   [${workflowId}] Generating Jira title and summary using OpenAI...`);
  const { title: generatedTitle, summary: generatedSummary, acceptanceCriteria } = await generateJiraTitleAndSummary(inputText, workflowId);

  // Get Slack permalink if channel and message timestamp are provided
  let slackPermalink = null;
  if (slackChannel && slackMessageTs) {
    slackPermalink = await getSlackPermalink(slackChannel, slackMessageTs, workflowId);
  }

  // Build description with summary, acceptance criteria, and Slack permalink
  let fullDescription = generatedSummary;
  
  // Add acceptance criteria
  if (acceptanceCriteria) {
    fullDescription += `\n## Acceptance Criteria\n${acceptanceCriteria}`;
  }
  
  if (slackPermalink) {
    fullDescription += `\n**Slack Message:** [View in Slack](${slackPermalink})`;
  }

  // Convert to ADF format (textToADF now handles markdown links)
  const descriptionADF = textToADF(fullDescription);

  // Use generated title as summary (Jira uses "summary" field for the ticket title)
  // Ensure it's within Jira's 255 character limit
  let finalSummary = generatedTitle || (summary && summary.length > 255 ? summary.substring(0, 252) + '...' : summary);
  if (finalSummary && finalSummary.length > 255) {
    finalSummary = finalSummary.substring(0, 252) + '...';
  }

  const payload = {
    fields: {
      project: { key: JIRA_PROJECT_KEY },
      summary: finalSummary,
      description: descriptionADF,
      issuetype: { name: JIRA_ISSUE_TYPE },
      labels: ['slack-generated', 'auto-rca', 'github-analysis'],
    },
  };

  const response = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Authorization: jiraAuthHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jira API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const result = await response.json();
  console.log(`   [${workflowId}] Ticket created: ${result.key}`);
  return {
    key: result.key,
    url: `${JIRA_BASE_URL}/browse/${result.key}`,
    id: result.id,
  };
}

/**
 * Download file from Slack and upload as attachment to Jira ticket
 */
async function uploadSlackFileToJira(issueKey, slackFile, workflowId = 'unknown') {
  try {
    console.log(`   [${workflowId}] Downloading ${slackFile.name} from Slack...`);
    
    // Download file from Slack
    const slackResponse = await fetch(slackFile.url_private, {
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
    });
    
    if (!slackResponse.ok) {
      throw new Error(`Failed to download from Slack: ${slackResponse.status}`);
    }
    
    const fileBuffer = await slackResponse.buffer();
    console.log(`   [${workflowId}] Downloaded ${fileBuffer.length} bytes`);
    
    // Upload to Jira
    const form = new FormData();
    form.append('file', fileBuffer, {
      filename: slackFile.name,
      contentType: slackFile.mimetype || 'application/octet-stream',
    });
    
    console.log(`   [${workflowId}] Uploading to Jira ticket ${issueKey}...`);
    const jiraResponse = await fetch(
      `${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/attachments`,
      {
        method: 'POST',
        headers: {
          Authorization: jiraAuthHeader,
          'X-Atlassian-Token': 'no-check',
          ...form.getHeaders(),
        },
        body: form,
      }
    );
    
    if (!jiraResponse.ok) {
      const errorText = await jiraResponse.text();
      throw new Error(`Jira upload failed: ${jiraResponse.status} - ${errorText}`);
    }
    
    const result = await jiraResponse.json();
    console.log(`   [${workflowId}] ✅ Uploaded ${slackFile.name} to Jira`);
    return result;
  } catch (error) {
    console.error(`   [${workflowId}] ❌ Failed to upload ${slackFile.name}:`, error.message);
    return null;
  }
}

/**
 * Upload attachments from Slack to Jira ticket
 */
export async function uploadAttachmentsToJira(issueKey, attachments = [], workflowId = 'unknown') {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  
  console.log(`   [${workflowId}] Uploading ${attachments.length} attachment(s) to Jira...`);
  
  const uploadResults = [];
  for (const file of attachments) {
    const result = await uploadSlackFileToJira(issueKey, file, workflowId);
    if (result) {
      uploadResults.push(result);
    }
  }
  
  console.log(`   [${workflowId}] Successfully uploaded ${uploadResults.length}/${attachments.length} attachments`);
  return uploadResults;
}

/**
 * Post a comment on a Jira ticket
 */
export async function postJiraComment(issueKey, { text }, workflowId = 'unknown') {
  if (!JIRA_BASE_URL || !JIRA_USER || !JIRA_API_TOKEN) {
    throw new Error('Jira credentials not configured');
  }
  
  console.log(`   [${workflowId}] Posting comment to ticket: ${issueKey}`);
  console.log(`   [${workflowId}] Comment length: ${text.length} characters`);

  const commentADF = textToADF(text);

  const payload = {
    body: commentADF,
  };

  const response = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: {
      Authorization: jiraAuthHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jira API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const result = await response.json();
  console.log(`   [${workflowId}] Comment posted successfully to ${issueKey}`);
  return result;
}

