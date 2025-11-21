import { createJiraTicket, uploadAttachmentsToJira } from './jira-service.js';
import { findRelevantFilesWithGrep } from './github-service.js';
import { performRCA } from './rca-service.js';
import { generateTestCases } from './test-cases-service.js';
import { postJiraComment } from './jira-service.js';
import { WebClient } from '@slack/web-api';

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

/**
 * Process Slack event: Read issue, analyze repo, create Jira ticket, and run RCA analysis
 */
export async function processSlackEvent(slackEvent, githubRepo, issueDescription, attachments = []) {
  const workflowId = `workflow-${Date.now()}`;
  const startTime = Date.now();
  
  console.log('\n' + '='.repeat(80));
  console.log(`🚀 [${workflowId}] WORKFLOW STARTED - Issue received from Slack`);
  console.log('='.repeat(80));
  console.log(`📋 Issue Description: ${issueDescription}`);
  console.log(`👤 Slack User: ${slackEvent.user}`);
  console.log(`💬 Slack Channel: ${slackEvent.channel}`);
  console.log(`⏰ Timestamp: ${new Date().toISOString()}`);
  console.log(`📝 Full Message: ${slackEvent.text || ''}`);
  console.log(`📎 Attachments: ${attachments.length}`);
  console.log('-'.repeat(80));
  
  try {
    const channel = slackEvent.channel;
    const threadTs = slackEvent.ts;
    const messageText = slackEvent.text || '';

    // Send initial acknowledgment to Slack (non-blocking - continue even if it fails)
    if (!githubRepo) {
      console.error(`❌ [${workflowId}] GitHub repository missing - cannot proceed`);
      console.error(`   Issue: ${issueDescription}`);
      console.error(`   Repo in message: false`);
      console.error(`   Repo in env: ${!!(process.env.GITHUB_REPO || process.env.BACKEND_REPO_URL)}`);
      try {
        await slackClient.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `⚠️ GitHub repository is required but not provided.\n\nPlease provide a GitHub repository URL in your message, or set GITHUB_REPO in environment variables.\n\nExample: @bot The login button is not working. Analyze https://github.com/owner/repo`,
        });
      } catch (slackError) {
        console.warn(`   [${workflowId}] Failed to post Slack message (non-blocking):`, slackError.message);
      }
      return;
    }

    const defaultRepo = process.env.GITHUB_REPO || process.env.BACKEND_REPO_URL;
    const repoSource = githubRepo === defaultRepo ? 'environment' : 'message';
    console.log(`✅ [${workflowId}] GitHub repository identified`);
    console.log(`   Repository: ${githubRepo}`);
    console.log(`   Source: ${repoSource}`);
    console.log(`   Issue: ${issueDescription}`);

    // Send initial acknowledgment (non-blocking)
    try {
      await slackClient.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `📋 Issue: ${issueDescription}\n🔍 Analyzing repository...\n📝 Creating Jira ticket...`,
      });
    } catch (slackError) {
      console.warn(`   [${workflowId}] Failed to post Slack acknowledgment (non-blocking):`, slackError.message);
      console.warn(`   [${workflowId}] Continuing workflow without Slack notifications...`);
    }

    // Step 1: Find relevant files using grep based on issue keywords
    console.log('\n' + '-'.repeat(80));
    console.log(`📊 [${workflowId}] STEP 1: Finding Relevant Files`);
    console.log('-'.repeat(80));
    console.log(`   Repository: ${githubRepo}`);
    console.log(`   Issue: ${issueDescription}`);
    const fileSearchStart = Date.now();
    
    let relevantFiles = [];
    try {
      relevantFiles = await findRelevantFilesWithGrep(issueDescription, workflowId);
      const fileSearchTime = ((Date.now() - fileSearchStart) / 1000).toFixed(2);
      console.log(`✅ [${workflowId}] File search completed`);
      console.log(`   Relevant files found: ${relevantFiles.length}`);
      console.log(`   Search time: ${fileSearchTime}s`);
      if (relevantFiles.length > 0) {
        console.log(`   Sample files: ${relevantFiles.slice(0, 5).join(', ')}`);
      }
    } catch (error) {
      const fileSearchTime = ((Date.now() - fileSearchStart) / 1000).toFixed(2);
      console.error(`❌ [${workflowId}] File search failed after ${fileSearchTime}s`);
      console.error(`   Error: ${error.message}`);
      console.error(`   Stack: ${error.stack}`);
      try {
        await slackClient.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `❌ Failed to search repository: ${error.message}`,
        });
      } catch (slackError) {
        console.warn(`   [${workflowId}] Failed to post Slack error message (non-blocking):`, slackError.message);
      }
      return;
    }

    // Step 2: Create Jira ticket with the issue description
    console.log('\n' + '-'.repeat(80));
    console.log(`🎫 [${workflowId}] STEP 2: Creating Jira Ticket`);
    console.log('-'.repeat(80));
    console.log(`   Issue: ${issueDescription}`);
    console.log(`   Project: ${process.env.JIRA_PROJECT_KEY}`);
    const ticketStart = Date.now();
    
    let issueKey = null;
    let issueUrl = null;
    try {
      // Build description (attachments will be uploaded separately)
      let description = `Issue: ${issueDescription}\n\nReported from Slack. Analyzing codebase for root cause analysis.`;
      
      if (attachments && attachments.length > 0) {
        description += `\n\n**Attachments**: ${attachments.length} file(s) attached`;
      }
      
      const ticketResult = await createJiraTicket({
        summary: issueDescription.length > 200 
          ? issueDescription.substring(0, 197) + '...' 
          : issueDescription,
        description,
        githubRepo,
        issueDescription,
        slackMessage: messageText,
        slackChannel: channel,
        slackMessageTs: threadTs,
      }, workflowId);
      issueKey = ticketResult.key;
      issueUrl = ticketResult.url;
      const ticketTime = ((Date.now() - ticketStart) / 1000).toFixed(2);
      console.log(`✅ [${workflowId}] Jira ticket created successfully`);
      console.log(`   Ticket Key: ${issueKey}`);
      console.log(`   Ticket URL: ${issueUrl}`);
      console.log(`   Creation time: ${ticketTime}s`);
      
      // Upload attachments to Jira if present
      if (attachments && attachments.length > 0) {
        console.log(`\n   [${workflowId}] Uploading ${attachments.length} attachment(s) to Jira...`);
        try {
          await uploadAttachmentsToJira(issueKey, attachments, workflowId);
        } catch (uploadError) {
          console.warn(`   [${workflowId}] Failed to upload some attachments (non-blocking):`, uploadError.message);
        }
      }
    } catch (error) {
      const ticketTime = ((Date.now() - ticketStart) / 1000).toFixed(2);
      console.error(`❌ [${workflowId}] Jira ticket creation failed after ${ticketTime}s`);
      console.error(`   Error: ${error.message}`);
      console.error(`   Stack: ${error.stack}`);
      try {
        await slackClient.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `❌ Failed to create Jira ticket: ${error.message}`,
        });
      } catch (slackError) {
        console.warn(`   [${workflowId}] Failed to post Slack error message (non-blocking):`, slackError.message);
      }
      return;
    }

    // Update Slack with Jira ticket link (non-blocking)
    try {
      await slackClient.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `✅ Jira ticket created: <${issueUrl}|${issueKey}>\n🔬 Running RCA analysis on the issue...`,
      });
    } catch (slackError) {
      console.warn(`   [${workflowId}] Failed to post Slack update (non-blocking):`, slackError.message);
    }

    // Step 3: Perform iterative RCA analysis using AI agent
    console.log('\n' + '-'.repeat(80));
    console.log(`🔬 [${workflowId}] STEP 3: Performing Iterative RCA Analysis`);
    console.log('-'.repeat(80));
    console.log(`   Issue: ${issueDescription}`);
    console.log(`   Relevant files: ${relevantFiles.length}`);
    console.log(`   OpenAI Model: ${process.env.OPENAI_MODEL || 'gpt-4-turbo-preview'}`);
    console.log(`   Max iterations: 30`);
    const rcaStart = Date.now();
    
    let rcaResult = null;
    try {
      rcaResult = await performRCA({
        githubRepo,
        issueDescription,
        slackMessage: messageText,
        relevantFiles,
      }, workflowId);
      const rcaTime = ((Date.now() - rcaStart) / 1000).toFixed(2);
      console.log(`✅ [${workflowId}] RCA analysis completed`);
      console.log(`   Analysis time: ${rcaTime}s`);
      console.log(`   Summary length: ${rcaResult.summary.length} characters`);
      console.log(`   Root cause length: ${rcaResult.rootCause.length} characters`);
      console.log(`   Recommended fix length: ${rcaResult.recommendedFix.length} characters`);
    } catch (error) {
      const rcaTime = ((Date.now() - rcaStart) / 1000).toFixed(2);
      console.error(`❌ [${workflowId}] RCA analysis failed after ${rcaTime}s`);
      console.error(`   Error: ${error.message}`);
      console.error(`   Stack: ${error.stack}`);
      try {
        await slackClient.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `❌ Failed to perform RCA analysis: ${error.message}`,
        });
      } catch (slackError) {
        console.warn(`   [${workflowId}] Failed to post Slack error message (non-blocking):`, slackError.message);
      }
      // Still post error to Jira
      try {
        await postJiraComment(issueKey, {
          text: `RCA Analysis Failed: ${error.message}`,
        }, workflowId);
      } catch (jiraError) {
        console.error(`   [${workflowId}] Failed to post error to Jira:`, jiraError.message);
      }
      return;
    }

    // Step 4: Post RCA results as comment on Jira ticket
    console.log('\n' + '-'.repeat(80));
    console.log(`💬 [${workflowId}] STEP 4: Posting RCA Results to Jira`);
    console.log('-'.repeat(80));
    console.log(`   Ticket: ${issueKey}`);
    const commentStart = Date.now();
    
    try {
      // Add warning banner if RCA was incomplete
      const warningBanner = rcaResult.incomplete 
        ? `{panel:title=⚠️ Incomplete Analysis|borderStyle=dashed|borderColor=#ffab00|titleBGColor=#fff3cd|bgColor=#fff3cd}\n` +
          `This RCA analysis reached the maximum iteration limit (30 iterations) and may be incomplete. ` +
          `The findings below represent the best plausible analysis based on the investigation performed so far.\n` +
          `{panel}\n\n`
        : '';
      
      await postJiraComment(issueKey, {
        text: `${warningBanner}## Automated RCA Analysis\n\n${rcaResult.summary}\n\n### Root Cause\n\n${rcaResult.rootCause}\n\n### Recommended Fix\n\n${rcaResult.recommendedFix}\n\n### Analysis Details\n\n${rcaResult.details}`,
      }, workflowId);
      const commentTime = ((Date.now() - commentStart) / 1000).toFixed(2);
      console.log(`✅ [${workflowId}] RCA results posted to Jira${rcaResult.incomplete ? ' (incomplete)' : ''}`);
      console.log(`   Ticket: ${issueKey}`);
      console.log(`   Comment time: ${commentTime}s`);
    } catch (error) {
      const commentTime = ((Date.now() - commentStart) / 1000).toFixed(2);
      console.error(`❌ [${workflowId}] Failed to post RCA results after ${commentTime}s`);
      console.error(`   Error: ${error.message}`);
      console.error(`   Stack: ${error.stack}`);
      try {
        await slackClient.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `⚠️ RCA analysis completed but failed to post to Jira: ${error.message}`,
        });
      } catch (slackError) {
        console.warn(`   [${workflowId}] Failed to post Slack error message (non-blocking):`, slackError.message);
      }
      return;
    }

    // Step 5: Generate test cases based on RCA analysis
    console.log('\n' + '-'.repeat(80));
    console.log(`🧪 [${workflowId}] STEP 5: Generating Test Cases`);
    console.log('-'.repeat(80));
    console.log(`   Issue: ${issueDescription}`);
    console.log(`   Relevant files: ${relevantFiles.length}`);
    console.log(`   OpenAI Model: ${process.env.OPENAI_MODEL || 'gpt-4-turbo-preview'}`);
    console.log(`   Max iterations: 20`);
    const testCasesStart = Date.now();
    
    let testCasesResult = null;
    try {
      testCasesResult = await generateTestCases({
        rcaResult,
        relevantFiles,
        githubRepo,
        issueDescription,
      }, workflowId);
      const testCasesTime = ((Date.now() - testCasesStart) / 1000).toFixed(2);
      console.log(`✅ [${workflowId}] Test case generation completed`);
      console.log(`   Generation time: ${testCasesTime}s`);
      console.log(`   Test cases generated: ${testCasesResult.testCases.length}`);
      console.log(`   Summary: ${testCasesResult.summary.substring(0, 100)}...`);
    } catch (error) {
      const testCasesTime = ((Date.now() - testCasesStart) / 1000).toFixed(2);
      console.error(`❌ [${workflowId}] Test case generation failed after ${testCasesTime}s`);
      console.error(`   Error: ${error.message}`);
      console.error(`   Stack: ${error.stack}`);
      try {
        await slackClient.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `⚠️ Test case generation failed: ${error.message}`,
        });
      } catch (slackError) {
        console.warn(`   [${workflowId}] Failed to post Slack error message (non-blocking):`, slackError.message);
      }
      // Continue workflow even if test case generation fails
      testCasesResult = null;
    }

    // Step 6: Post test cases to Jira ticket (if generated)
    if (testCasesResult && testCasesResult.testCases.length > 0) {
      console.log('\n' + '-'.repeat(80));
      console.log(`📝 [${workflowId}] STEP 6: Posting Test Cases to Jira`);
      console.log('-'.repeat(80));
      console.log(`   Ticket: ${issueKey}`);
      console.log(`   Test cases: ${testCasesResult.testCases.length}`);
      const testCasesCommentStart = Date.now();
      
      try {
        await postJiraComment(issueKey, {
          text: testCasesResult.fullResponse,
        }, workflowId);
        const testCasesCommentTime = ((Date.now() - testCasesCommentStart) / 1000).toFixed(2);
        console.log(`✅ [${workflowId}] Test cases posted to Jira`);
        console.log(`   Ticket: ${issueKey}`);
        console.log(`   Comment time: ${testCasesCommentTime}s`);
      } catch (error) {
        const testCasesCommentTime = ((Date.now() - testCasesCommentStart) / 1000).toFixed(2);
        console.error(`❌ [${workflowId}] Failed to post test cases after ${testCasesCommentTime}s`);
        console.error(`   Error: ${error.message}`);
        console.error(`   Stack: ${error.stack}`);
        try {
          await slackClient.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `⚠️ Test cases generated but failed to post to Jira: ${error.message}`,
          });
        } catch (slackError) {
          console.warn(`   [${workflowId}] Failed to post Slack error message (non-blocking):`, slackError.message);
        }
        // Continue workflow even if posting fails
      }
    } else {
      console.log(`\n   [${workflowId}] ⚠️ No test cases generated, skipping Jira post`);
    }

    // Final success message (non-blocking)
    try {
      const testCasesInfo = testCasesResult && testCasesResult.testCases.length > 0 
        ? `\n🧪 Generated ${testCasesResult.testCases.length} test cases`
        : '';
      await slackClient.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `✅ RCA analysis completed and posted to <${issueUrl}|${issueKey}>${testCasesInfo}`,
      });
    } catch (slackError) {
      console.warn(`   [${workflowId}] Failed to post Slack success message (non-blocking):`, slackError.message);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n' + '='.repeat(80));
    console.log(`🎉 [${workflowId}] WORKFLOW COMPLETED SUCCESSFULLY`);
    console.log('='.repeat(80));
    console.log(`   Ticket: ${issueKey}`);
    console.log(`   Total time: ${totalTime}s`);
    console.log(`   Completed at: ${new Date().toISOString()}`);
    console.log('='.repeat(80) + '\n');
  } catch (error) {
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error('\n' + '='.repeat(80));
    console.error(`💥 [${workflowId}] WORKFLOW FAILED`);
    console.error('='.repeat(80));
    console.error(`   Error: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);
    console.error(`   Failed after: ${totalTime}s`);
    console.error('='.repeat(80) + '\n');
    throw error;
  }
}

