import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

// Repository path (cloned during Docker build)
const REPO_PATH = '/app/repo';

/**
 * Check if repository exists (cloned during Docker build)
 */
async function checkRepositoryExists() {
  try {
    await fs.access(REPO_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract keywords from issue description for grep search
 */
function extractKeywords(issueDescription) {
  if (!issueDescription) return [];
  
  // Remove common words and extract meaningful terms
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
    'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can',
    'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
    'not', 'no', 'when', 'where', 'what', 'which', 'who', 'how', 'why',
    'issue', 'problem', 'error', 'bug', 'fix', 'create', 'ticket'
  ]);
  
  // Extract words (alphanumeric, at least 3 chars)
  const words = issueDescription
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 3 && !stopWords.has(word));
  
  // Remove duplicates and return
  return [...new Set(words)];
}

/**
 * Use grep to find relevant files based on keywords
 */
export async function findRelevantFilesWithGrep(issueDescription, workflowId = 'unknown') {
  console.log(`\n   [${workflowId}] ========================================`);
  console.log(`   [${workflowId}] 🔍 FILE SEARCH - Starting`);
  console.log(`   [${workflowId}] ========================================`);
  console.log(`   [${workflowId}] Repository Path: ${REPO_PATH}`);
  console.log(`   [${workflowId}] Issue Description: ${issueDescription}`);
  
  const repoExists = await checkRepositoryExists();
  if (!repoExists) {
    console.error(`   [${workflowId}] ❌ Repository does not exist at ${REPO_PATH}`);
    throw new Error(`Repository not found at ${REPO_PATH}. Please ensure GITHUB_REPO is set during Docker build.`);
  }
  console.log(`   [${workflowId}] ✅ Repository exists at ${REPO_PATH}`);
  
  // Verify repository has files
  try {
    const entries = await fs.readdir(REPO_PATH);
    console.log(`   [${workflowId}] 📁 Repository has ${entries.length} top-level items`);
    console.log(`   [${workflowId}] Top-level items: ${entries.slice(0, 10).join(', ')}${entries.length > 10 ? '...' : ''}`);
    if (entries.length === 0) {
      throw new Error(`Repository at ${REPO_PATH} appears to be empty`);
    }
  } catch (error) {
    console.error(`   [${workflowId}] ❌ Error reading repository: ${error.message}`);
    throw new Error(`Cannot read repository at ${REPO_PATH}: ${error.message}`);
  }
  
  const keywords = extractKeywords(issueDescription);
  console.log(`   [${workflowId}] Extracted keywords: ${keywords.slice(0, 10).join(', ')}`);
  
  if (keywords.length === 0) {
    console.log(`   [${workflowId}] No keywords found, will search all code files`);
    // If no keywords, return first 50 code files
    const codeExtensions = [
      '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c', '.h',
      '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.sh',
      '.yaml', '.yml', '.json', '.xml', '.html', '.css', '.scss',
      '.vue', '.svelte', '.dart', '.lua', '.sql', '.md'
    ];
    const extensionArgs = codeExtensions.map(ext => `-name "*${ext}"`).join(' -o ');
    const findCommand = `find ${REPO_PATH} -type f \\( ${extensionArgs} \\) ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" ! -path "*/build/*" ! -path "*/.next/*" ! -path "*/.cache/*" 2>/dev/null | head -50`;
    try {
      const { stdout } = await execAsync(findCommand, { maxBuffer: 10 * 1024 * 1024 });
      const files = stdout
        .split('\n')
        .filter(line => line.trim())
        .map(file => path.relative(REPO_PATH, file.trim()));
      console.log(`   [${workflowId}] Found ${files.length} code files (no keywords, using all)`);
      return files;
    } catch (error) {
      console.warn(`   [${workflowId}] Error finding files: ${error.message}`);
      return [];
    }
  }
  
  const codeExtensions = [
    '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c', '.h',
    '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.sh',
    '.yaml', '.yml', '.json', '.xml', '.html', '.css', '.scss',
    '.vue', '.svelte', '.dart', '.lua', '.sql', '.md'
  ];
  
  const extensionPattern = codeExtensions.map(ext => `\\${ext}`).join('|');
  const relevantFiles = new Set();
  
  // Use grep to search for keywords in code files
  for (const keyword of keywords) {
    try {
      // Build include patterns for grep (Alpine grep doesn't support --include with braces)
      // Use find + grep combination for better compatibility
      const extensionArgs = codeExtensions.map(ext => `-name "*${ext}"`).join(' -o ');
      const findCommand = `find ${REPO_PATH} -type f \\( ${extensionArgs} \\) ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" ! -path "*/build/*" ! -path "*/.next/*" ! -path "*/.cache/*" 2>/dev/null | head -100`;
      
      console.log(`   [${workflowId}] 🔎 Searching for keyword: "${keyword}"`);
      console.log(`   [${workflowId}] Running find command to locate code files...`);
      
      const { stdout: findOutput } = await execAsync(findCommand, {
        maxBuffer: 10 * 1024 * 1024
      });
      
      const allCodeFiles = findOutput
        .split('\n')
        .filter(line => line.trim())
        .map(file => file.trim());
      
      console.log(`   [${workflowId}] Found ${allCodeFiles.length} total code files in repository`);
      if (allCodeFiles.length > 0) {
        console.log(`   [${workflowId}] Sample files: ${allCodeFiles.slice(0, 5).map(f => path.relative(REPO_PATH, f)).join(', ')}`);
      }
      
      if (allCodeFiles.length === 0) {
        console.log(`   [${workflowId}] ⚠️ No code files found in repository`);
        continue;
      }
      
      // Now grep through these files for the keyword
      console.log(`   [${workflowId}] 🔍 Grepping for "${keyword}" in ${Math.min(allCodeFiles.length, 100)} files...`);
      const filesWithKeyword = [];
      for (const filePath of allCodeFiles.slice(0, 100)) { // Limit to first 100 files for performance
        try {
          const grepCommand = `grep -l "${keyword}" "${filePath}" 2>/dev/null`;
          await execAsync(grepCommand, { timeout: 2000 });
          filesWithKeyword.push(filePath);
          const relativePath = path.relative(REPO_PATH, filePath);
          console.log(`   [${workflowId}]   ✅ Found in: ${relativePath}`);
        } catch (error) {
          // grep returns non-zero if no match, which is fine
          if (error.code !== 1) {
            // Ignore other errors for individual files
          }
        }
      }
      
      const relativeFiles = filesWithKeyword
        .map(file => path.relative(REPO_PATH, file));
      
      relativeFiles.forEach(file => relevantFiles.add(file));
      
      console.log(`   [${workflowId}] ✅ Keyword "${keyword}" found in ${relativeFiles.length} files`);
      if (relativeFiles.length > 0) {
        console.log(`   [${workflowId}] Files: ${relativeFiles.slice(0, 10).join(', ')}${relativeFiles.length > 10 ? '...' : ''}`);
      }
    } catch (error) {
      // If find fails, try simpler grep approach
      console.warn(`   [${workflowId}] Find command failed, trying simple grep: ${error.message}`);
      try {
        const simpleGrepCommand = `grep -ril "${keyword}" ${REPO_PATH} --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" --include="*.py" --include="*.rb" --include="*.java" 2>/dev/null | head -20`;
        const { stdout } = await execAsync(simpleGrepCommand, {
          maxBuffer: 10 * 1024 * 1024
        });
        
        const files = stdout
          .split('\n')
          .filter(line => line.trim())
          .map(file => path.relative(REPO_PATH, file.trim()));
        
        files.forEach(file => relevantFiles.add(file));
        console.log(`   [${workflowId}] Keyword "${keyword}" found in ${files.length} files (simple grep)`);
      } catch (grepError) {
        if (grepError.code !== 1) {
          console.warn(`   [${workflowId}] Error searching for "${keyword}": ${grepError.message}`);
        }
      }
    }
  }
  
  const fileList = Array.from(relevantFiles);
  console.log(`\n   [${workflowId}] ========================================`);
  console.log(`   [${workflowId}] 📊 FILE SEARCH - Results`);
  console.log(`   [${workflowId}] ========================================`);
  console.log(`   [${workflowId}] Total relevant files found: ${fileList.length}`);
  if (fileList.length > 0) {
    console.log(`   [${workflowId}] Files to analyze:`);
    fileList.slice(0, 50).forEach((file, index) => {
      console.log(`   [${workflowId}]   ${index + 1}. ${file}`);
    });
    if (fileList.length > 50) {
      console.log(`   [${workflowId}]   ... and ${fileList.length - 50} more (limited to 50)`);
    }
  } else {
    console.log(`   [${workflowId}] ⚠️ No relevant files found for analysis`);
  }
  console.log(`   [${workflowId}] ========================================\n`);
  
  // Limit to top 50 most relevant files
  return fileList.slice(0, 50);
}

/**
 * Get repository path for agent tools
 */
export function getRepoPath() {
  return REPO_PATH;
}

/**
 * Read file content (used by agent tools)
 */
export async function readFile(filePath, workflowId = 'unknown') {
  try {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(REPO_PATH, filePath);
    
    // Security: Ensure path is within repo
    const resolvedPath = path.resolve(fullPath);
    const repoResolved = path.resolve(REPO_PATH);
    
    if (!resolvedPath.startsWith(repoResolved)) {
      console.error(`   [${workflowId}] ❌ Security: File path outside repository: ${filePath}`);
      throw new Error('File path outside repository');
    }
    
    console.log(`   [${workflowId}] 📖 Reading file: ${filePath}`);
    console.log(`   [${workflowId}]    Full path: ${resolvedPath}`);
    
    const content = await fs.readFile(resolvedPath, 'utf-8');
    console.log(`   [${workflowId}]    ✅ Read successfully: ${content.length} characters`);
    console.log(`   [${workflowId}]    First 200 chars: ${content.substring(0, 200).replace(/\n/g, '\\n')}...`);
    return content;
  } catch (error) {
    console.error(`   [${workflowId}] ❌ Error reading file ${filePath}:`, error.message);
    throw error;
  }
}

/**
 * Execute command (used by agent tools)
 */
export async function executeCommand(command, workflowId = 'unknown', timeout = 10000) {
  try {
    console.log(`   [${workflowId}] ⚙️  Executing command: ${command}`);
    console.log(`   [${workflowId}]    Working directory: ${REPO_PATH}`);
    
    const { stdout, stderr } = await Promise.race([
      execAsync(command, { 
        cwd: REPO_PATH,
        maxBuffer: 10 * 1024 * 1024,
        timeout
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Command timeout')), timeout)
      )
    ]);
    
    const result = {
      stdout: stdout || '',
      stderr: stderr || '',
      success: true
    };
    
    console.log(`   [${workflowId}]    ✅ Command completed successfully`);
    console.log(`   [${workflowId}]    stdout length: ${result.stdout.length} chars`);
    console.log(`   [${workflowId}]    stderr length: ${result.stderr.length} chars`);
    if (result.stdout.length > 0 && result.stdout.length < 500) {
      console.log(`   [${workflowId}]    stdout: ${result.stdout.substring(0, 500)}`);
    }
    if (result.stderr.length > 0) {
      console.log(`   [${workflowId}]    stderr: ${result.stderr.substring(0, 200)}`);
    }
    return result;
  } catch (error) {
    console.error(`   [${workflowId}]    ❌ Command failed: ${error.message}`);
    return {
      stdout: '',
      stderr: error.message,
      success: false
    };
  }
}

/**
 * List directory contents (used by agent tools)
 */
export async function listDirectory(dirPath, workflowId = 'unknown') {
  try {
    const fullPath = path.isAbsolute(dirPath) ? dirPath : path.join(REPO_PATH, dirPath);
    
    // Security: Ensure path is within repo
    const resolvedPath = path.resolve(fullPath);
    const repoResolved = path.resolve(REPO_PATH);
    
    if (!resolvedPath.startsWith(repoResolved)) {
      console.error(`   [${workflowId}] ❌ Security: Directory path outside repository: ${dirPath}`);
      throw new Error('Directory path outside repository');
    }
    
    console.log(`   [${workflowId}] 📂 Listing directory: ${dirPath}`);
    console.log(`   [${workflowId}]    Full path: ${resolvedPath}`);
    
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const result = entries.map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : 'file',
      path: path.relative(REPO_PATH, path.join(resolvedPath, entry.name))
    }));
    
    console.log(`   [${workflowId}]    ✅ Found ${result.length} items`);
    const dirs = result.filter(r => r.type === 'directory').map(r => r.name);
    const files = result.filter(r => r.type === 'file').map(r => r.name);
    console.log(`   [${workflowId}]    Directories (${dirs.length}): ${dirs.slice(0, 10).join(', ')}${dirs.length > 10 ? '...' : ''}`);
    console.log(`   [${workflowId}]    Files (${files.length}): ${files.slice(0, 10).join(', ')}${files.length > 10 ? '...' : ''}`);
    return result;
  } catch (error) {
    console.error(`   [${workflowId}] ❌ Error listing directory ${dirPath}:`, error.message);
    throw error;
  }
}
