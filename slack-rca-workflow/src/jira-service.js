import fetch from 'node-fetch';

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_USER = process.env.JIRA_USER || process.env.JIRA_EMAIL; // Support both JIRA_USER and JIRA_EMAIL
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'PROJ';
const JIRA_ISSUE_TYPE = process.env.JIRA_ISSUE_TYPE || 'Task';

const jiraAuthHeader = `Basic ${Buffer.from(`${JIRA_USER}:${JIRA_API_TOKEN}`).toString('base64')}`;

/**
 * Unescape markdown characters that the AI might have escaped
 */
function unescapeMarkdown(text) {
  if (!text) return text;
  
  return text
    // Unescape backticks
    .replace(/\\`/g, '`')
    // Unescape asterisks
    .replace(/\\\*/g, '*')
    // Unescape underscores (but be careful not to break intentional escaping)
    .replace(/\\_/g, '_')
    // Unescape square brackets
    .replace(/\\\[/g, '[')
    .replace(/\\\]/g, ']')
    // Unescape parentheses
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    // Unescape hash symbols
    .replace(/\\#/g, '#')
    // Unescape pipes
    .replace(/\\\|/g, '|');
}

/**
 * Convert markdown text to Atlassian Document Format (ADF)
 * Supports: headings, bold, inline code, code blocks
 */
function textToADF(text) {
  // First, unescape any escaped markdown
  text = unescapeMarkdown(text);
  const content = [];
  const lines = String(text || '').split(/\r?\n/);

  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockContent = [];

  for (const line of lines) {
    // Handle code blocks (```language or ```)
    const codeBlockMatch = line.match(/^```(\w*)\s*$/);
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
        inCodeBlock = true;
        codeBlockLang = codeBlockMatch[1] || 'plain';
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Handle headings (## Heading)
    const headingMatch = line.match(/^(#+)\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 6); // Max heading level 6
      content.push({
        type: 'heading',
        attrs: { level: level },
        content: [{ type: 'text', text: headingMatch[2].trim() }],
      });
      continue;
    }

    // Handle paragraphs with bold (**text**) and inline code (`code`)
    const paragraphContent = [];
    let remainingText = line;

    // Regex to find bold (**text**) or inline code (`code`)
    const regex = /(\*\*([^*]+?)\*\*)|(`([^`]+?)`)/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(remainingText)) !== null) {
      // Add text before the match
      if (match.index > lastIndex) {
        paragraphContent.push({ 
          type: 'text', 
          text: remainingText.substring(lastIndex, match.index) 
        });
      }

      if (match[2]) { 
        // Bold match
        paragraphContent.push({ 
          type: 'text', 
          text: match[2], 
          marks: [{ type: 'strong' }] 
        });
      } else if (match[4]) { 
        // Inline code match
        paragraphContent.push({ 
          type: 'text', 
          text: match[4], 
          marks: [{ type: 'code' }] 
        });
      }
      lastIndex = regex.lastIndex;
    }

    // Add any remaining text after the last match
    if (lastIndex < remainingText.length) {
      paragraphContent.push({ 
        type: 'text', 
        text: remainingText.substring(lastIndex) 
      });
    }

    if (paragraphContent.length > 0) {
      content.push({ type: 'paragraph', content: paragraphContent });
    } else if (line.length === 0) {
      content.push({ type: 'paragraph', content: [] }); // Empty paragraph for blank lines
    } else {
      content.push({ type: 'paragraph', content: [{ type: 'text', text: line }] }); // Fallback
    }
  }

  // Close any unclosed code block
  if (inCodeBlock && codeBlockContent.length > 0) {
    content.push({
      type: 'codeBlock',
      attrs: { language: codeBlockLang || 'plain' },
      content: [{ type: 'text', text: codeBlockContent.join('\n') }],
    });
  }

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

