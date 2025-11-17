# Slack to Jira Ticket Bot

A serverless bot that automatically creates Jira tickets from Slack messages when users mention the bot with "create a ticket". Supports file attachments, thread replies, and parent message handling.

## Features

- ✅ Creates Jira tickets from Slack messages
- ✅ Supports file attachments (images, PDFs, etc.)
- ✅ Handles thread replies (uses parent message content)
- ✅ Prevents duplicate ticket creation
- ✅ Fast response to prevent Slack retries
- ✅ Environment variable configuration

## Prerequisites

- Node.js 16+ (for local development)
- A Slack workspace with admin access
- A Jira Cloud instance with API access
- AWS account (for Lambda deployment)

## Local Development Setup

### 1. Clone and Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory:

```env
# Jira Configuration
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-jira-api-token

# Jira Issue Defaults
JIRA_PROJECT_KEY=PROJECT
JIRA_ISSUE_TYPE=Task
JIRA_LABELS=from-slack,incoming-ticket

# Slack Configuration
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
```

### 3. Get Your Credentials

#### Jira API Token
1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Copy the token and add it to `.env` as `JIRA_API_TOKEN`

#### Slack Bot Token
1. Go to https://api.slack.com/apps
2. Create a new app or select your existing app
3. Go to "OAuth & Permissions"
4. Add the following Bot Token Scopes:
   - `app_mentions:read` - To receive app mention events
   - `channels:history` - To read channel messages
   - `groups:history` - To read private channel messages
   - `im:history` - To read direct messages
   - `files:read` - To download file attachments
   - `chat:write` - To post messages in Slack
5. Install the app to your workspace
6. Copy the "Bot User OAuth Token" (starts with `xoxb-`) and add it to `.env` as `SLACK_BOT_TOKEN`

### 4. Configure Slack Event Subscriptions

1. In your Slack app settings, go to "Event Subscriptions"
2. Enable Events
3. Set Request URL to: `http://your-ngrok-url.ngrok.io` (see step 5)
4. Subscribe to bot events:
   - `app_mention` - When users mention your bot
5. Save changes

### 5. Expose Local Server (using ngrok)

```bash
# Install ngrok (if not already installed)
# macOS: brew install ngrok
# Or download from https://ngrok.com/download

# Start ngrok tunnel
ngrok http 3000
```

Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`) and use it as your Slack Event Subscriptions Request URL.

### 6. Run Local Server

```bash
npm start
```

The server will run on `http://localhost:3000`. Make sure your ngrok tunnel is pointing to this port.

### 7. Test the Bot

1. In Slack, mention your bot: `@your-bot create a ticket`
2. Optionally add a screenshot or file attachment
3. Check your Jira project for the new ticket

## AWS Lambda Deployment

### 1. Prepare Deployment Package

Create a deployment package with your code and dependencies:

```bash
# Install dependencies
npm install --production

# Create deployment package (excluding dev dependencies)
zip -r lambda-deployment.zip . -x "*.git*" -x "node_modules/.cache/*" -x ".env" -x "local-server.mjs"
```

### 2. Create Lambda Function

1. Go to AWS Lambda Console
2. Click "Create function"
3. Choose "Author from scratch"
4. Configure:
   - Function name: `slack-jira-bot`
   - Runtime: Node.js 18.x or 20.x
   - Architecture: x86_64
5. Click "Create function"

### 3. Upload Code

1. In the Lambda function, go to "Code" tab
2. Click "Upload from" → ".zip file"
3. Upload your `lambda-deployment.zip`
4. Set the handler to: `lambda.handler`

### 4. Configure Environment Variables

In Lambda function → Configuration → Environment variables, add:

```
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_PROJECT_KEY=PROJECT
JIRA_ISSUE_TYPE=Task
JIRA_LABELS=from-slack,incoming-ticket
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
```

### 5. Configure Lambda Settings

1. **Timeout**: Set to at least 30 seconds (Configuration → General configuration → Edit)
2. **Memory**: 256 MB minimum (512 MB recommended for file uploads)
3. **Handler**: `lambda.handler`

### 6. Set Up API Gateway (or Function URL)

#### Option A: Function URL (Simpler)

1. In Lambda function, go to "Configuration" → "Function URL"
2. Click "Create function URL"
3. Choose "NONE" for Auth type (Slack will handle auth)
4. Copy the Function URL
5. Use this URL as your Slack Event Subscriptions Request URL

#### Option B: API Gateway (More Control)

1. Create a new API Gateway REST API
2. Create a POST method pointing to your Lambda function
3. Deploy the API
4. Copy the API endpoint URL
5. Use this URL as your Slack Event Subscriptions Request URL

### 7. Update Slack Event Subscriptions

1. Go to your Slack app → Event Subscriptions
2. Update Request URL to your Lambda Function URL or API Gateway endpoint
3. Slack will verify the URL (make sure your Lambda is deployed first)

### 8. Test Lambda Function

Use the Lambda test console or test from Slack:

1. Mention your bot in Slack: `@your-bot create a ticket`
2. Check CloudWatch Logs for execution logs
3. Verify the ticket was created in Jira

## Project Structure

```
iksha-hackathon/
├── lambda.mjs          # Main Lambda handler
├── local-server.mjs    # Local development server
├── package.json        # Dependencies
├── .env               # Environment variables (not in git)
└── README.md          # This file
```

## How It Works

1. **Slack Event Received**: Bot receives an `app_mention` event
2. **Immediate Response**: Returns 200 OK within 3 seconds to prevent Slack retries
3. **Deduplication Check**: Verifies event hasn't been processed
4. **Text Extraction**: Extracts clean text from Slack message (handles rich text blocks)
5. **Thread Detection**: If thread reply, fetches parent message
6. **Ticket Creation**: Creates Jira ticket with description
7. **File Attachments**: Downloads files from Slack and uploads to Jira
8. **Slack Reply**: Posts confirmation message in thread

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `JIRA_BASE_URL` | Your Jira instance URL (e.g., `https://company.atlassian.net`) | Yes |
| `JIRA_EMAIL` | Email associated with your Jira account | Yes |
| `JIRA_API_TOKEN` | Jira API token from Atlassian account settings | Yes |
| `JIRA_PROJECT_KEY` | Jira project key where tickets will be created | Yes |
| `JIRA_ISSUE_TYPE` | Issue type (e.g., `Task`, `Bug`, `Story`) | Yes |
| `JIRA_LABELS` | Comma-separated labels to add to tickets | No |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (starts with `xoxb-`) | Yes |

## Slack Bot Scopes Required

- `app_mentions:read` - Receive app mention events
- `channels:history` - Read public channel messages
- `groups:history` - Read private channel messages
- `im:history` - Read direct messages
- `files:read` - Download file attachments
- `chat:write` - Post messages in Slack

## Troubleshooting

### Duplicate Tickets Being Created

- ✅ **Fixed**: The bot now responds immediately to prevent Slack retries
- ✅ Deduplication cache prevents processing the same event twice
- Check CloudWatch logs for "Duplicate event detected" messages

### Files Not Uploading

- Verify `files:read` scope is added to your Slack bot
- Check that files are actually attached to the Slack message
- Review logs for file download/upload errors

### "Not Authed" Errors

- Verify `SLACK_BOT_TOKEN` is correct in environment variables
- Ensure bot is installed to your workspace
- Check that all required scopes are added

### Jira API Errors

- Verify `JIRA_API_TOKEN` is correct
- Check that the API token hasn't expired
- Ensure the Jira user has permission to create issues in the project
- Verify `JIRA_PROJECT_KEY` and `JIRA_ISSUE_TYPE` are correct

### Lambda Timeout

- Increase Lambda timeout to 30+ seconds
- Check CloudWatch logs for slow operations
- File uploads may take time for large files

### Local Server Not Receiving Events

- Verify ngrok is running and tunnel is active
- Check that Slack Event Subscriptions URL matches ngrok URL
- Ensure local server is running on port 3000
- Check ngrok web interface for incoming requests

## Development

### Running Locally

```bash
npm start
```

Server runs on `http://localhost:3000`

### Testing

1. Use ngrok to expose local server
2. Update Slack Event Subscriptions URL
3. Mention bot in Slack: `@your-bot create a ticket`
4. Check console logs and Jira for results

## Security Notes

- ⚠️ Never commit `.env` file to git (already in `.gitignore`)
- ⚠️ Rotate API tokens regularly
- ⚠️ Use AWS Secrets Manager for production Lambda deployments
- ⚠️ Restrict Lambda execution role permissions (least privilege)

