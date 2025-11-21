import OpenAI from 'openai';
import { readFile, executeCommand, listDirectory, getRepoPath } from './github-service.js';
import fs from 'fs/promises';
import path from 'path';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const REPO_PATH = getRepoPath();
const MAX_ITERATIONS = 30;

/**
 * Tool definitions for the AI agent
 */
const tools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a source code file or config file. Returns the full file content.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Relative path to the file from repository root (e.g., "ad-portal-api/app/controllers/application_controller.rb" or "ad-portal-api/app/models/user.rb")',
          },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exec',
      description: 'Execute shell commands like ls, grep, cat, find, etc. Useful for exploring directory structure, searching for patterns, or reading files. Has 10 second timeout. The app is built using Ruby on Rails. The Rails conventions are followed.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute (e.g., "ls src/", "grep -r \"error\" logs/", "cat config.json")',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories in a given path. Returns array of items with name, type (file/directory), and path.',
      parameters: {
        type: 'object',
        properties: {
          dir_path: {
            type: 'string',
            description: 'Relative path to directory from repository root (e.g., "src/" or "backend/src/auth/")',
          },
        },
        required: ['dir_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Submit the final RCA report with markdown formatting.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Brief summary of the issue. Use **bold** for key terms and `backticks` for code.',
          },
          root_cause: {
            type: 'string',
            description: 'Root cause explanation with file locations. Use **bold**, `backticks` for files, and ```code blocks.',
          },
          recommended_fix: {
            type: 'string',
            description: 'Recommended solutions with code examples in ```code blocks.',
          },
          analysis_details: {
            type: 'string',
            description: 'Optional additional technical details.',
          },
        },
        required: ['summary', 'root_cause', 'recommended_fix'],
      },
    },
  },
];

/**
 * Execute tool calls from AI agent
 */
async function executeToolCall(toolCall, workflowId) {
  const { name, arguments: args } = toolCall.function;
  const parsedArgs = JSON.parse(args);
  
  console.log(`   [${workflowId}] 🔧 Tool: ${name}(${JSON.stringify(parsedArgs)})`);
  
  try {
    switch (name) {
      case 'read_file':
        const content = await readFile(parsedArgs.file_path, workflowId);
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: 'read_file',
          content: JSON.stringify({ content, file_path: parsedArgs.file_path }),
        };
        
      case 'exec':
        const result = await executeCommand(parsedArgs.command, workflowId, 10000);
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: 'exec',
          content: JSON.stringify({
            stdout: result.stdout,
            stderr: result.stderr,
            success: result.success,
          }),
        };
        
      case 'list_directory':
        const items = await listDirectory(parsedArgs.dir_path, workflowId);
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: 'list_directory',
          content: JSON.stringify({ items }),
        };
        
      case 'finish':
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          name: 'finish',
          content: JSON.stringify({
            summary: parsedArgs.summary,
            root_cause: parsedArgs.root_cause,
            recommended_fix: parsedArgs.recommended_fix,
            analysis_details: parsedArgs.analysis_details || '',
          }),
        };
        
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error(`   [${workflowId}] Tool execution error: ${error.message}`);
    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: name,
      content: JSON.stringify({ error: error.message }),
    };
  }
}

/**
 * Perform Root Cause Analysis using iterative AI agent
 */
export async function performRCA({ githubRepo, issueDescription, slackMessage, relevantFiles }, workflowId = 'unknown') {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured');
  }
  
  console.log(`   [${workflowId}] Starting iterative RCA investigation...`);
  console.log(`   [${workflowId}] Issue: ${issueDescription}`);
  console.log(`   [${workflowId}] Relevant files found: ${relevantFiles.length}`);
  console.log(`   [${workflowId}] Repository: ${REPO_PATH}`);
  
  const model = process.env.OPENAI_MODEL || 'gpt-4-turbo-preview';
  const isNewModel = model.includes('gpt-4o') || model.includes('gpt-5') || model.includes('o1');
  
  // Initial system message
  const systemMessage = `You are a senior software engineer performing Root Cause Analysis.

Issue: ${issueDescription}
Repository: ${githubRepo}
Relevant files: ${relevantFiles.slice(0, 10).join(', ')}${relevantFiles.length > 10 ? '...' : ''}

Tools available: read_file, exec, list_directory, finish

Instructions:
1. Investigate the codebase to find the root cause
2. Read relevant files and search for patterns
3. When done, call 'finish' with formatted report

Format your report with markdown:
- Use **bold** for key terms and impacts
- Use \`backticks\` for file paths and code references  
- Use \`\`\`language for code blocks
- Include file locations and line numbers

Work efficiently. Max ${MAX_ITERATIONS} iterations.`;

  const messages = [
    {
      role: 'system',
      content: systemMessage,
    },
  ];
  
  let iteration = 0;
  let rcaResult = null;
  
  while (iteration < MAX_ITERATIONS && !rcaResult) {
    iteration++;
    console.log(`   [${workflowId}] Iteration ${iteration}/${MAX_ITERATIONS}`);
    
    try {
      const completionParams = {
        model: model,
        messages: messages,
        tools: tools,
        tool_choice: 'auto',
        temperature: 0.3,
      };
      
      if (isNewModel) {
        completionParams.max_completion_tokens = 4000;
      } else {
        completionParams.max_tokens = 4000;
      }
      
      const response = await openai.chat.completions.create(completionParams);
      const assistantMessage = response.choices[0].message;
      
      messages.push(assistantMessage);
      
      // Check if agent wants to use tools
      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        const toolResults = [];
        
        for (const toolCall of assistantMessage.tool_calls) {
          const toolResult = await executeToolCall(toolCall, workflowId);
          toolResults.push(toolResult);
          
          // If finish tool was called, extract the result
          if (toolCall.function.name === 'finish') {
            const finishData = JSON.parse(toolResult.content);
            rcaResult = {
              summary: finishData.summary,
              rootCause: finishData.root_cause,
              recommendedFix: finishData.recommended_fix,
              details: finishData.analysis_details || '',
              fullResponse: `## Summary\n${finishData.summary}\n\n## Root Cause\n${finishData.root_cause}\n\n## Recommended Fix\n${finishData.recommended_fix}\n\n## Analysis Details\n${finishData.analysis_details || ''}`,
            };
          }
        }
        
        // Add tool results to conversation
        messages.push(...toolResults);
      } else {
        // Agent provided text response (might be reasoning or final answer)
        if (assistantMessage.content) {
          console.log(`   [${workflowId}] Agent message: ${assistantMessage.content.substring(0, 200)}...`);
        }
        
        // If no tool calls and we have content, might be done
        if (assistantMessage.content && iteration > 5) {
          // Try to extract RCA from text response
          const content = assistantMessage.content;
          const summaryMatch = content.match(/## Summary\s*\n([\s\S]*?)(?=##|$)/i);
          const rootCauseMatch = content.match(/## Root Cause\s*\n([\s\S]*?)(?=##|$)/i);
          const recommendedFixMatch = content.match(/## Recommended Fix\s*\n([\s\S]*?)(?=##|$)/i);
          
          if (summaryMatch && rootCauseMatch && recommendedFixMatch) {
            rcaResult = {
              summary: summaryMatch[1].trim(),
              rootCause: rootCauseMatch[1].trim(),
              recommendedFix: recommendedFixMatch[1].trim(),
              details: content,
              fullResponse: content,
            };
          }
        }
      }
    } catch (error) {
      console.error(`   [${workflowId}] Error in iteration ${iteration}:`, error.message);
      throw new Error(`RCA investigation failed: ${error.message}`);
    }
  }
  
  if (!rcaResult) {
    throw new Error(`RCA investigation incomplete after ${MAX_ITERATIONS} iterations`);
  }
  
  console.log(`   [${workflowId}] ✅ RCA investigation completed in ${iteration} iterations`);
  return rcaResult;
}
