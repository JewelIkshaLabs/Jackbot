import OpenAI from 'openai';
import { readFile, executeCommand, listDirectory, getRepoPath } from './github-service.js';
import fs from 'fs/promises';
import path from 'path';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const REPO_PATH = getRepoPath();
const MAX_ITERATIONS = 20;

/**
 * Tool definitions for the AI agent
 */
const tools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a source code file, test file, config file, or spec file. Returns the full file content.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Relative path to the file from repository root (e.g., "src/auth/login.js" or "spec/models/user_spec.rb")',
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
      description: 'Execute shell commands like ls, grep, cat, find, etc. Useful for exploring directory structure, searching for test files, or reading files. Has 10 second timeout.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute (e.g., "find spec/ -name \'*_spec.rb\'", "grep -r \"describe\" test/", "cat package.json")',
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
            description: 'Relative path to directory from repository root (e.g., "spec/", "test/", or "src/controllers/")',
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
      description: 'Submit the final test cases report with comprehensive test cases for methods, controller actions, sidekiq jobs, and business workflows. Call this when test case generation is complete. Ensure that the files mentioned here are actuall present in the codebase.',
      parameters: {
        type: 'object',
        properties: {
          test_cases: {
            type: 'array',
            description: 'Array of test case objects, each containing test case details',
            items: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: 'Brief title/name of the test case',
                },
                type: {
                  type: 'string',
                  description: 'Type of test case: "unit_test", "integration_test", "controller_test", "job_test", "workflow_test", or "e2e_test"',
                },
                target: {
                  type: 'string',
                  description: 'What is being tested (e.g., "UserController#login", "LoginJob.perform", "authenticate_user method", "login workflow")',
                },
                description: {
                  type: 'string',
                  description: 'Detailed description of what the test case validates',
                },
                test_steps: {
                  type: 'array',
                  description: 'Array of test steps or assertions',
                  items: {
                    type: 'string',
                  },
                },
                expected_result: {
                  type: 'string',
                  description: 'Expected outcome or behavior',
                },
                priority: {
                  type: 'string',
                  description: 'Test priority: "critical", "high", "medium", or "low"',
                },
                related_files: {
                  type: 'array',
                  description: 'Array of file paths related to this test case',
                  items: {
                    type: 'string',
                  },
                },
              },
              required: ['title', 'type', 'target', 'description', 'test_steps', 'expected_result', 'priority'],
            },
          },
          summary: {
            type: 'string',
            description: 'Brief summary of the test cases generated and coverage',
          },
          test_coverage: {
            type: 'string',
            description: 'Description of what areas are covered by these test cases',
          },
        },
        required: ['test_cases', 'summary', 'test_coverage'],
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
            test_cases: parsedArgs.test_cases,
            summary: parsedArgs.summary,
            test_coverage: parsedArgs.test_coverage,
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
 * Generate test cases based on RCA analysis and relevant files
 */
export async function generateTestCases({ rcaResult, relevantFiles, githubRepo, issueDescription }, workflowId = 'unknown') {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured');
  }
  
  console.log(`   [${workflowId}] Starting test case generation...`);
  console.log(`   [${workflowId}] Issue: ${issueDescription}`);
  console.log(`   [${workflowId}] Relevant files: ${relevantFiles.length}`);
  console.log(`   [${workflowId}] Repository: ${REPO_PATH}`);
  
  const model = process.env.OPENAI_MODEL || 'gpt-4-turbo-preview';
  const isNewModel = model.includes('gpt-4o') || model.includes('gpt-5') || model.includes('o1');
  
  // Build context from RCA results
  const rcaContext = `
Root Cause: ${rcaResult.rootCause}
Recommended Fix: ${rcaResult.recommendedFix}
Summary: ${rcaResult.summary}
  `.trim();
  
  // Initial system message
  const systemMessage = `You are a senior QA engineer generating comprehensive test cases to validate a fix for a reported issue.

Repository: ${githubRepo}
Issue Reported: ${issueDescription}

Root Cause Analysis Results:
${rcaContext}

Relevant files identified: ${relevantFiles.slice(0, 20).join(', ')}${relevantFiles.length > 20 ? '...' : ''}

Your task is to generate comprehensive test cases that validate:
1. The root cause has been addressed
2. The recommended fix works correctly
3. Related functionality is not broken
4. Edge cases and error scenarios are covered

Test cases should cover:
- Unit tests for methods/functions
- Integration tests for workflows
- Controller action tests (for web frameworks)
- Background job tests (Sidekiq, Celery, etc.)
- End-to-end workflow tests
- Error handling and edge cases

You have access to tools that let you:
- Read files (read_file) - to understand code structure and existing tests
- Execute commands (exec) - to find test files, explore test structure
- List directories (list_directory) - to understand project structure

Investigation approach:
1. Explore the codebase structure, especially test directories (spec/, test/, __tests__/, etc.)
2. Read relevant source files to understand the code being fixed
3. Check existing test files to understand testing patterns and frameworks used
4. Identify all methods, controllers, jobs, and workflows that need testing
5. Generate comprehensive test cases covering:
   - Happy path scenarios
   - Edge cases
   - Error conditions
   - Integration points
6. Call 'finish' with your test cases report

Work systematically and use the tools to gather information. Maximum ${MAX_ITERATIONS} iterations.`;

  const messages = [
    {
      role: 'system',
      content: systemMessage,
    },
  ];
  
  let iteration = 0;
  let testCasesResult = null;
  
  while (iteration < MAX_ITERATIONS && !testCasesResult) {
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
            testCasesResult = {
              testCases: finishData.test_cases || [],
              summary: finishData.summary || '',
              testCoverage: finishData.test_coverage || '',
              fullResponse: formatTestCasesResponse(finishData),
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
          // Try to extract test cases from text response
          const content = assistantMessage.content;
          const testCasesMatch = content.match(/## Test Cases\s*\n([\s\S]*?)(?=##|$)/i);
          const summaryMatch = content.match(/## Summary\s*\n([\s\S]*?)(?=##|$)/i);
          const coverageMatch = content.match(/## Test Coverage\s*\n([\s\S]*?)(?=##|$)/i);
          
          if (testCasesMatch || summaryMatch) {
            // Try to parse test cases from markdown
            testCasesResult = {
              testCases: parseTestCasesFromMarkdown(content),
              summary: summaryMatch ? summaryMatch[1].trim() : '',
              testCoverage: coverageMatch ? coverageMatch[1].trim() : '',
              fullResponse: content,
            };
          }
        }
      }
    } catch (error) {
      console.error(`   [${workflowId}] Error in iteration ${iteration}:`, error.message);
      throw new Error(`Test case generation failed: ${error.message}`);
    }
  }
  
  if (!testCasesResult) {
    throw new Error(`Test case generation incomplete after ${MAX_ITERATIONS} iterations`);
  }
  
  console.log(`   [${workflowId}] ✅ Test case generation completed in ${iteration} iterations`);
  console.log(`   [${workflowId}] Generated ${testCasesResult.testCases.length} test cases`);
  return testCasesResult;
}

/**
 * Format test cases response for display
 */
function formatTestCasesResponse(data) {
  let output = `## Test Cases Summary\n\n${data.summary}\n\n`;
  output += `## Test Coverage\n\n${data.test_coverage}\n\n`;
  output += `## Generated Test Cases\n\n`;
  
  if (data.test_cases && Array.isArray(data.test_cases)) {
    data.test_cases.forEach((testCase, index) => {
      output += `### ${index + 1}. ${testCase.title}\n\n`;
      output += `**Type:** ${testCase.type}\n`;
      output += `**Target:** ${testCase.target}\n`;
      output += `**Priority:** ${testCase.priority}\n`;
      output += `**Description:** ${testCase.description}\n\n`;
      
      if (testCase.test_steps && Array.isArray(testCase.test_steps)) {
        output += `**Test Steps:**\n`;
        testCase.test_steps.forEach((step, stepIndex) => {
          output += `${stepIndex + 1}. ${step}\n`;
        });
        output += `\n`;
      }
      
      output += `**Expected Result:** ${testCase.expected_result}\n\n`;
      
      if (testCase.related_files && Array.isArray(testCase.related_files) && testCase.related_files.length > 0) {
        output += `**Related Files:** ${testCase.related_files.join(', ')}\n\n`;
      }
      
      output += `---\n\n`;
    });
  }
  
  return output;
}

/**
 * Parse test cases from markdown text (fallback)
 */
function parseTestCasesFromMarkdown(content) {
  // Simple parsing - extract numbered test cases
  const testCaseRegex = /###?\s*\d+\.\s*(.+?)(?=###?\s*\d+\.|$)/gs;
  const matches = content.matchAll(testCaseRegex);
  const testCases = [];
  
  for (const match of matches) {
    const testCaseText = match[1].trim();
    const titleMatch = testCaseText.match(/^(.+?)$/m);
    const typeMatch = testCaseText.match(/\*\*Type:\*\*\s*(.+?)$/m);
    const targetMatch = testCaseText.match(/\*\*Target:\*\*\s*(.+?)$/m);
    const descMatch = testCaseText.match(/\*\*Description:\*\*\s*(.+?)$/m);
    
    if (titleMatch) {
      testCases.push({
        title: titleMatch[1].trim(),
        type: typeMatch ? typeMatch[1].trim() : 'unit_test',
        target: targetMatch ? targetMatch[1].trim() : 'Unknown',
        description: descMatch ? descMatch[1].trim() : '',
        test_steps: [],
        expected_result: '',
        priority: 'medium',
        related_files: [],
      });
    }
  }
  
  return testCases;
}

