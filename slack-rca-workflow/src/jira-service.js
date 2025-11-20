import fetch from 'node-fetch';

const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_USER = process.env.JIRA_USER || process.env.JIRA_EMAIL; // Support both JIRA_USER and JIRA_EMAIL
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'PROJ';
const JIRA_ISSUE_TYPE = process.env.JIRA_ISSUE_TYPE || 'Task';

const jiraAuthHeader = `Basic ${Buffer.from(`${JIRA_USER}:${JIRA_API_TOKEN}`).toString('base64')}`;

/**
 * Convert plain text to Atlassian Document Format (ADF)
 */
function textToADF(text) {
  const paragraphs = String(text || '').split(/\r?\n/);
  const content = paragraphs.map((p) => {
    if (p.length === 0) {
      return { type: 'paragraph', content: [] };
    }
    return { type: 'paragraph', content: [{ type: 'text', text: p }] };
  });
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

