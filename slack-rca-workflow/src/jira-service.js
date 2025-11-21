import fetch from 'node-fetch';

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_USER = process.env.JIRA_USER || process.env.JIRA_EMAIL; // Support both JIRA_USER and JIRA_EMAIL
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'PROJ';
const JIRA_ISSUE_TYPE = process.env.JIRA_ISSUE_TYPE || 'Task';

const jiraAuthHeader = `Basic ${Buffer.from(`${JIRA_USER}:${JIRA_API_TOKEN}`).toString('base64')}`;

/**
 * Convert Markdown to Atlassian Document Format (ADF)
 * Supports: ## headings, **bold**, `inline code`, ```code blocks```, bullet lists, numbered lists
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
    
    if (codeBlockMatch) {
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
 * Create a Jira ticket
 */
export async function createJiraTicket({ summary, description, githubRepo, issueDescription, slackMessage }, workflowId = 'unknown') {
  if (!JIRA_BASE_URL || !JIRA_USER || !JIRA_API_TOKEN) {
    throw new Error('Jira credentials not configured');
  }
  
  console.log(`   [${workflowId}] Creating ticket in project: ${JIRA_PROJECT_KEY}`);
  console.log(`   [${workflowId}] Issue type: ${JIRA_ISSUE_TYPE}`);

  // Build description with metadata (repo not included - only used internally)
  const fullDescription = `${description}\n\n---\n\n*Metadata*\n- Source: Slack Bot\n- Generated: ${new Date().toISOString()}`;

  const descriptionADF = textToADF(fullDescription);

  const payload = {
    fields: {
      project: { key: JIRA_PROJECT_KEY },
      summary: summary.length > 255 ? summary.substring(0, 252) + '...' : summary,
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

