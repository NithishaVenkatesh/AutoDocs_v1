import { GoogleGenerativeAI } from '@google/generative-ai';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { Client } from '@neondatabase/serverless';
import { MerkleTree } from './merkle-utils';
import { createHash } from 'crypto';
import { sendSSEUpdate } from './sse';
import { ensureRepositoryStatus } from './repository-utils';

// Initialize Gemini
const genAI = new GoogleGenerativeAI("AIzaSyDeIoy2s-0allB6FKb0P9sIi3C3E9-cFHg");
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// Configuration
const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;

// Text splitter for code chunks
const textSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
});

// File extensions to process
const VALID_EXTS = ['.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.c', '.cpp', '.h', '.hpp'];

// Ignore patterns (as strings)
const IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  '.next',
  'build',
  'dist',
  'coverage',
  '__pycache__'
];

interface FileContent {
  path: string;
  content: string;
  size: number;
  sha: string;
  version?: number;
  updated_at?: string;
}

interface FileChange {
  path: string;
  action: 'added' | 'modified' | 'removed';
  content?: string;
  sha?: string;
}

interface ChunkWithHash {
  content: string;
  hash: string;
}

interface UpdateDocumentationResult {
  success: boolean;
  updatedFiles: number;
  totalChanges: number;
  message?: string;
}

// Function to generate Merkle root from chunks
async function generateMerkleRoot(chunks: string[]): Promise<{ root: string; hashes: string[] }> {
  const hashes = chunks.map(chunk => 
    createHash('sha256').update(chunk).digest('hex')
  );
  
  // If only one chunk, return its hash as root
  if (hashes.length === 1) {
    return { root: hashes[0], hashes };
  }

  // Build Merkle tree by hashing pairs
  let currentLevel = [...hashes];
  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
      nextLevel.push(createHash('sha256').update(left + right).digest('hex'));
    }
    currentLevel = nextLevel;
  }

  return { root: currentLevel[0], hashes };
}

async function generateDocsForFile(file: FileContent): Promise<string> {
  console.log(`🔍 [DEBUG] Processing file: ${file.path}`);
  
  // Skip very small files
  if (!file.content || file.content.length < 30) {
    console.log(`   ⚠️ File too small or empty, skipping: ${file.path}`);
    return `# Documentation for ${file.path}\n\nThis file is too small to generate documentation.`;
  }
  
  console.log(`   📏 File size: ${(file.content.length / 1024).toFixed(2)} KB`);

  try {
    console.log('   ✂️  Splitting content into chunks...');
    const chunks = await textSplitter.splitText(file.content);
    const docParts: string[] = [];
    
    console.log(`   📦 Split into ${chunks.length} chunks`);

    // Process each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`   🔄 Processing chunk ${i + 1}/${chunks.length}...`);
      
      const prompt = `You are a professional technical writer for software projects.\nAnalyze the following code and write **developer documentation** in Markdown.\n\nExplain clearly:\n- The overall purpose of this code\n- Key classes, functions, and parameters\n- Return values and interactions\n- Any special logic or dependencies\n- Example usages if visible\n\nKeep it professional and concise. Avoid repeating boilerplate.\n\n### File: ${file.path}\n### Code snippet (${i + 1}/${chunks.length})\n${chunk}`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      if (text) {
        docParts.push(`## Part ${i + 1}\n${text}`);
      }
    }

    return `# Documentation for \`${file.path}\`

${docParts.join('\n\n')}`;
  } catch (error) {
    console.error(`Error generating docs for ${file.path}:`, error);
    return `# Documentation for \`${file.path}\`

Error generating documentation. Please try again later.`;
  }
}

export async function getFileDocumentation(repoId: number, filePath: string) {
  const db = new Client(process.env.DATABASE_URL!);
  
  try {
    await db.connect();
    
    const result = await db.query(
      'SELECT content, version, updated_at FROM repo_documentation WHERE repo_id = $1 AND file_path = $2',
      [repoId, filePath]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return {
      content: result.rows[0].content,
      version: result.rows[0].version,
      updatedAt: result.rows[0].updated_at
    };
  } finally {
    await db.end();
  }
}

export async function updateDocumentation(
  repoId: number,
  repoName: string,
  changes: FileChange[]
): Promise<UpdateDocumentationResult> {
  const db = new Client(process.env.DATABASE_URL!);
  let updatedFiles = 0;
  let totalChanges = 0;

  try {
    await db.connect();
    
    // Process each file change
    for (const change of changes) {
      if (change.action === 'removed') {
        // Delete documentation for removed files
        await db.query(
          'DELETE FROM repo_documentation WHERE repo_id = $1 AND file_path = $2',
          [repoId, change.path]
        );
        updatedFiles++;
        totalChanges++;
        continue;
      }

      if (!change.content) {
        console.log(`Skipping ${change.path} - no content provided`);
        continue;
      }

      // Generate documentation for the file
      const fileContent: FileContent = {
        path: change.path,
        content: change.content,
        size: change.content.length,
        sha: change.sha || ''
      };

      const documentation = await generateDocsForFile(fileContent);
      
      // Update the documentation in the database
      await db.query(
        `INSERT INTO repo_documentation 
         (repo_id, file_path, content, version, updated_at, merkle_root, chunk_hashes)
         VALUES ($1, $2, $3, 
                 COALESCE((SELECT version + 1 FROM repo_documentation 
                          WHERE repo_id = $1 AND file_path = $2), 1),
                 NOW(),
                 $4, $5)
         ON CONFLICT (repo_id, file_path) 
         DO UPDATE SET 
           content = EXCLUDED.content,
           version = EXCLUDED.version,
           updated_at = NOW(),
           merkle_root = EXCLUDED.merkle_root,
           chunk_hashes = EXCLUDED.chunk_hashes`,
        [repoId, change.path, documentation, null, null] // TODO: Add Merkle root and chunk hashes
      );
      
      updatedFiles++;
      totalChanges++;
    }

    return {
      success: true,
      updatedFiles,
      totalChanges,
      message: `Updated ${updatedFiles} files with ${totalChanges} total changes`
    };
    
  } catch (error) {
    console.error('Error updating documentation:', error);
    return {
      success: false,
      updatedFiles,
      totalChanges,
      message: error instanceof Error ? error.message : 'Unknown error'
    };
  } finally {
    await db.end();
  }
}

export async function generateDocumentation(repoId: number) {
  console.log(`\n📚 [DEBUG] Starting documentation generation for repo ID: ${repoId}`);
  const startTime = Date.now();
  const db = new Client(process.env.DATABASE_URL);
  
  try {
    await db.connect();
    
    // Check if there are any files to process
    const { rowCount } = await db.query(
      'SELECT 1 FROM repo_contents WHERE repo_id = $1 LIMIT 1',
      [repoId]
    );

    if (rowCount === 0) {
      return { 
        success: false, 
        message: 'No files found in repository',
        processedFiles: 0 
      };
    }
    
    // Get all files for the repo
    const { rows: files } = await db.query<FileContent>(
      'SELECT file_path as path, content, file_size as size, sha FROM repo_contents WHERE repo_id = $1',
      [repoId]
    );

    // Filter valid code files
    const validFiles = files.filter(file => {
      const hasValidExt = VALID_EXTS.some(ext => file.path.endsWith(ext));
      const shouldIgnore = IGNORE_PATTERNS.some(pattern => file.path.includes(pattern));
      return hasValidExt && !shouldIgnore;
    });
    
    if (validFiles.length === 0) {
      return { success: true, processedFiles: 0, message: 'No valid code files found' };
    }

    // Get the repository name for SSE updates
    const { rows: repoInfo } = await db.query(
      'SELECT name FROM repositories WHERE id = $1',
      [repoId]
    );
    const repoName = repoInfo[0]?.name || 'unknown';

    // Store generated documents for completion update
    const generatedDocuments = [];

    // Process each file
    let processedFiles = 0;
    for (const file of validFiles) {
      try {
        // Generate documentation for the file
        const documentation = await generateDocsForFile(file);

        // Store the documentation
        await db.query(
          `INSERT INTO repo_documentation
           (repo_id, file_path, content, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (repo_id, file_path)
           DO UPDATE SET
             content = EXCLUDED.content,
             updated_at = NOW()`,
          [repoId, file.path, documentation]
        );

        processedFiles++;

        // Store the document for completion update
        generatedDocuments.push({
          filePath: file.path,
          content: documentation
        });

        // Send real-time update for this document with content
        sendSSEUpdate({
          type: 'documentation_stored',
          repoName: repoName,
          filePath: file.path,
          content: documentation, // Send the actual document content
          processedFiles: processedFiles,
          totalFiles: validFiles.length,
          status: 'generating',
          message: `Documentation generated for ${file.path}`,
          timestamp: new Date().toISOString()
        });

        console.log(`📝 [SSE] Sent update for ${file.path} in repo ${repoName}`);

        // If this is the first document, ensure the repository status is updated
        if (processedFiles === 1) {
          await ensureRepositoryStatus(repoName);
        }

      } catch (error) {
        console.error(`❌ Error processing ${file.path}:`, error);

        // Send error update for this file
        sendSSEUpdate({
          type: 'documentation_error',
          repoName: repoName,
          filePath: file.path,
          error: error instanceof Error ? error.message : String(error),
          processedFiles: processedFiles,
          totalFiles: validFiles.length,
          status: 'error',
          message: `Failed to generate documentation for ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date().toISOString()
        });
      }
    }

    // Send completion update with all document contents
    sendSSEUpdate({
      type: 'documentation_complete',
      repoName: repoName,
      processedFiles: processedFiles,
      totalFiles: validFiles.length,
      status: 'complete',
      message: `Documentation generation completed for ${repoName}. Processed ${processedFiles} files.`,
      timestamp: new Date().toISOString(),
      documents: generatedDocuments // Include all document contents
    });

    console.log(`✅ [SSE] Documentation generation completed for ${repoName}`);

    return {
      success: true,
      message: 'Documentation generated successfully',
      processedFiles,
      totalTime: (Date.now() - startTime) / 1000
    };
  } catch (error) {
    console.error('Documentation generation failed:', error);
    throw error;
  } finally {
    await db.end().catch(console.error);
  }
}
