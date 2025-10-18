import { GoogleGenerativeAI } from '@google/generative-ai';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Client } from '@neondatabase/serverless';
import { createHash } from 'crypto';

// Custom logger
const log = {
  info: (requestId: string, message: string, data?: any) => {
    const timestamp = new Date().toISOString();
    if (data) console.log(`[${timestamp}] [${requestId}] ℹ️ ${message}`, JSON.stringify(data, null, 2));
    else console.log(`[${timestamp}] [${requestId}] ℹ️ ${message}`);
  },
  warn: (requestId: string, message: string, data?: any) => {
    const timestamp = new Date().toISOString();
    if (data) console.warn(`[${timestamp}] [${requestId}] ⚠️ ${message}`, JSON.stringify(data, null, 2));
    else console.warn(`[${timestamp}] [${requestId}] ⚠️ ${message}`);
  },
  error: (requestId: string, message: string, error?: any) => {
    const timestamp = new Date().toISOString();
    if (error) {
      const errorInfo = error instanceof Error ? `${error.message}\n${error.stack}` : JSON.stringify(error, null, 2);
      console.error(`[${timestamp}] [${requestId}] ❌ ${message}\n${errorInfo}`);
    } else console.error(`[${timestamp}] [${requestId}] ❌ ${message}`);
  },
  success: (requestId: string, message: string, data?: any) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${requestId}] ✅ ${message}`, data ? JSON.stringify(data, null, 2) : '');
  },
  debug: (requestId: string, message: string, data?: any) => {
    if (process.env.NODE_ENV === 'development') {
      const timestamp = new Date().toISOString();
      console.debug(`[${timestamp}] [${requestId}] 🔍 ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
  }
};

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI("AIzaSyDeIoy2s-0allB6FKb0P9sIi3C3E9-cFHg");
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// Text splitter configuration
const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;
const textSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
});

// File extensions & ignore patterns
const VALID_EXTS = ['.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.c', '.cpp', '.h', '.hpp'];
const IGNORE_PATTERNS = ['node_modules', '.git', '.next', 'build', 'dist', 'coverage', '__pycache__'];

// --- Utility function ---
function getRepoName(fullName: string, fallbackName?: string) {
  if (!fullName) return fallbackName || '';
  const parts = fullName.split('/');
  return parts[parts.length - 1]; // always take the repo name only
}

// --- Merkle hash generation ---
async function generateMerkleRoot(chunks: string[]): Promise<{ root: string; hashes: string[] }> {
  const hashes = chunks.map(chunk => createHash('sha256').update(chunk).digest('hex'));
  if (hashes.length === 1) return { root: hashes[0], hashes };

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

// --- Generate documentation for a file ---
async function generateDocsForFile(file: { path: string; content: string; size?: number; sha?: string; }): Promise<string> {
  if (!file.content || file.content.length < 30) return `# Documentation for ${file.path}\n\nThis file is too small to generate documentation.`;

  const chunks = await textSplitter.splitText(file.content);
  const docParts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const prompt = `You are a professional technical writer for software projects.\nAnalyze the following code and write developer documentation in Markdown.\n\n### File: ${file.path}\n### Code snippet (${i + 1}/${chunks.length})\n${chunk}`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    if (text) docParts.push(`## Part ${i + 1}\n${text}`);
  }
  return `# Documentation for \`${file.path}\`\n\n${docParts.join('\n\n')}`;
}

// --- Generate documentation for a repository ---
export async function generateDocumentation(repoId: number) {
  const startTime = Date.now();
  const db = new Client(process.env.DATABASE_URL);
  try {
    await db.connect();
    
    // Fetch repository info
    const reposResult = await db.query(
      'SELECT id, name, full_name, github_repo_id FROM repos WHERE id = $1',
      [repoId]
    );
    if (reposResult.rows.length === 0) return { success: false, message: 'Repository not found', processedFiles: 0 };
    
    const repoInfo = reposResult.rows[0];
    const repoName = getRepoName(repoInfo.full_name, repoInfo.name); // <--- always repo name only
    
    // Ensure repo_documentation table exists
    await db.query(`
      CREATE TABLE IF NOT EXISTS repo_documentation (
        id SERIAL PRIMARY KEY,
        repo_id INTEGER NOT NULL,
        repo_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content TEXT NOT NULL,
        merkle_root TEXT,
        chunk_hashes TEXT[],
        version INTEGER DEFAULT 1,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(repo_id, file_path)
      )
    `);

    // Fetch files from repo_contents
    const { rows: files } = await db.query(
      'SELECT file_path as path, content, file_size as size, sha FROM repo_contents WHERE repo_id = $1',
      [repoId]
    );
    
    const validFiles = files.filter(file => {
      const hasValidExt = VALID_EXTS.some(ext => file.path.endsWith(ext));
      const shouldIgnore = IGNORE_PATTERNS.some(pattern => file.path.includes(pattern));
      return hasValidExt && !shouldIgnore;
    });

    let processedFiles = 0;
    for (const file of validFiles) {
      try {
        const chunks = await textSplitter.splitText(file.content);
        const { root: merkleRoot, hashes: chunkHashes } = await generateMerkleRoot(chunks);
        const documentation = await generateDocsForFile(file);
        await db.query(
          `INSERT INTO repo_documentation 
           (repo_id, repo_name, file_path, content, merkle_root, chunk_hashes)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (repo_id, file_path) 
           DO UPDATE SET 
             repo_name = EXCLUDED.repo_name,
             content = EXCLUDED.content, 
             merkle_root = EXCLUDED.merkle_root,
             chunk_hashes = EXCLUDED.chunk_hashes,
             updated_at = NOW()`,
          [repoId, repoName, file.path, documentation, merkleRoot, JSON.stringify(chunkHashes)]
        );
        processedFiles++;
      } catch (err) {
        console.error(`Error processing file ${file.path}:`, err);
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    return { success: true, message: 'Documentation generated', processedFiles, totalTime: parseFloat(totalTime) };

  } finally {
    await db.end();
  }
}

// --- Update documentation (on file changes) ---
export async function updateDocumentation(
  repoId: number,
  repoFullName: string,
  fileChanges: { path: string; action: 'added' | 'modified' | 'removed'; content?: string; }[],
  requestId: string = 'system'
) {
  const repoName = getRepoName(repoFullName); // <--- normalize to repo name only
  const db = new Client(process.env.DATABASE_URL);
  await db.connect();

  try {
    await db.query('BEGIN');
    let updatedFiles = 0;
    const chunkHashes: string[] = [];

    for (const file of fileChanges) {
      if (file.action === 'removed') {
        await db.query('DELETE FROM repo_documentation WHERE repo_id = $1 AND file_path = $2', [repoId, file.path]);
        updatedFiles++;
        continue;
      }

      if (!file.content) continue;

      const chunks = await textSplitter.splitText(file.content);
      const chunkHashesForFile = chunks.map(chunk => createHash('sha256').update(chunk).digest('hex'));
      chunkHashes.push(...chunkHashesForFile);

      const docContent = await generateDocsForFile({ path: file.path, content: file.content });
      const currentVersion = await db.query('SELECT version FROM repo_documentation WHERE repo_id = $1 AND file_path = $2', [repoId, file.path]);
      const newVersion = currentVersion.rows[0]?.version + 1 || 1;

      await db.query(
        `INSERT INTO repo_documentation 
         (repo_id, repo_name, file_path, content, version, updated_at, chunk_hashes)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6)
         ON CONFLICT (repo_id, file_path) 
         DO UPDATE SET 
           repo_name = EXCLUDED.repo_name,
           content = EXCLUDED.content,
           version = EXCLUDED.version,
           updated_at = EXCLUDED.updated_at,
           chunk_hashes = EXCLUDED.chunk_hashes`,
        [repoId, repoName, file.path, docContent, newVersion, JSON.stringify(chunkHashesForFile)]
      );

      updatedFiles++;
    }

    let finalMerkleRoot: string | undefined;

    if (chunkHashes.length > 0) {
      const { root: merkleRoot } = await generateMerkleRoot(chunkHashes);
      await db.query('UPDATE repositories SET merkle_root = $1, updated_at = NOW() WHERE id = $2', [merkleRoot, repoId]);
      finalMerkleRoot = merkleRoot;
    }

    await db.query('COMMIT');
    return { success: true, updatedFiles, totalChanges: fileChanges.length, message: `Updated ${updatedFiles} files`, merkleRoot: finalMerkleRoot };

  } catch (err) {
    await db.query('ROLLBACK');
    return { success: false, updatedFiles: 0, totalChanges: fileChanges.length, message: err instanceof Error ? err.message : 'Unknown error', merkleRoot: undefined };
  } finally {
    await db.end();
  }
}
