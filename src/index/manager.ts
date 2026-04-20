/**
 * 代码库索引管理器
 * 管理文件收集、索引和搜索操作
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import axios, { AxiosInstance } from 'axios';
import iconv from 'iconv-lite';
import ignore from 'ignore';
import { logger } from '../logger.js';
import { normalizeProjectPath } from '../utils/pathUtils.js';

/**
 * Blob 接口
 */
interface Blob {
  path: string;
  content: string;
}

/**
 * 索引结果接口
 */
interface IndexResult {
  status: string;
  message: string;
  project_path?: string;
  failed_batches?: number[];
  stats?: {
    total_blobs: number;
    existing_blobs: number;
    new_blobs: number;
    skipped_blobs: number;
  };
}

/**
 * 使用多种编码尝试读取文件
 */
async function readFileWithEncoding(filePath: string): Promise<string> {
  const buffer = await fs.promises.readFile(filePath);
  const encodings = ['utf-8', 'gbk', 'gb2312', 'latin1'];

  for (const encoding of encodings) {
    try {
      const content = iconv.decode(buffer, encoding);
      
      // 验证解码是否成功：检查是否有过多的替换字符 (U+FFFD)
      const replacementChars = (content.match(/\uFFFD/g) || []).length;
      
      // 使用更智能的阈值：短文件用绝对值，长文件用比例
      if (content.length > 0) {
        if (content.length < 100) {
          // 短文件：超过 5 个替换字符就认为编码不对
          if (replacementChars > 5) {
            continue;
          }
        } else {
          // 长文件：超过 5% 的替换字符就认为编码不对
          if (replacementChars / content.length > 0.05) {
            continue;
          }
        }
      }
      
      // 只在非 utf-8 编码时记录 debug 日志（减少日志量）
      if (encoding !== 'utf-8') {
        logger.debug(`Successfully read ${filePath} with encoding: ${encoding}`);
      }
      return content;
    } catch (error) {
      continue;
    }
  }

  // 最后手段：使用 utf-8（可能会有字符丢失）
  const content = iconv.decode(buffer, 'utf-8');
  logger.warning(`Read ${filePath} with utf-8 (some characters may be lost)`);
  return content;
}

/**
 * 计算 blob 名称（SHA-256 哈希）
 */
function calculateBlobName(filePath: string, content: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(filePath, 'utf-8');
  hash.update(content, 'utf-8');
  return hash.digest('hex');
}

/**
 * 睡眠工具函数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 索引管理器类
 */
export class IndexManager {
  private storagePath: string;
  private baseUrl: string;
  private token: string;
  private textExtensions: Set<string>;
  private batchSize: number;
  private maxLinesPerBlob: number;
  private excludePatterns: string[];
  private projectsFile: string;
  private httpClient: AxiosInstance;

  constructor(
    storagePath: string,
    baseUrl: string,
    token: string,
    textExtensions: Set<string>,
    batchSize: number,
    maxLinesPerBlob: number = 800,
    excludePatterns: string[] = []
  ) {
    this.storagePath = storagePath;
    
    // 确保 baseUrl 包含协议前缀
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      this.baseUrl = `https://${baseUrl}`.replace(/\/$/, '');
      logger.debug(`自动添加 https:// 协议到 base_url: ${this.baseUrl}`);
    } else {
      this.baseUrl = baseUrl.replace(/\/$/, '');
    }
    
    this.token = token;
    this.textExtensions = textExtensions;
    this.batchSize = batchSize;
    this.maxLinesPerBlob = maxLinesPerBlob;
    this.excludePatterns = excludePatterns;
    this.projectsFile = path.join(storagePath, 'projects.json');

    // 确保存储目录存在
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }

    // 设置 HTTP 客户端
    this.httpClient = axios.create({
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    logger.info(
      `IndexManager initialized with storage path: ${storagePath}, batch_size: ${batchSize}, max_lines_per_blob: ${maxLinesPerBlob}, exclude_patterns: ${excludePatterns.length} patterns`
    );
  }

  /**
   * 标准化路径，统一使用正斜杠，支持 WSL
   */
  private normalizePath(filePath: string): string {
    return normalizeProjectPath(filePath);
  }

  /**
   * 加载 .gitignore 文件
   */
  private loadGitignore(rootPath: string): ReturnType<typeof ignore> | null {
    const gitignorePath = path.join(rootPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      logger.debug(`No .gitignore found at ${gitignorePath}`);
      return null;
    }

    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      const patterns = content.split('\n');
      const ig = ignore().add(patterns);
      logger.info(`Loaded .gitignore with ${patterns.length} patterns from ${gitignorePath}`);
      return ig;
    } catch (error) {
      logger.warning(`Failed to load .gitignore from ${gitignorePath}: ${error}`);
      return null;
    }
  }

  /**
   * 检查路径是否应该被排除
   */
  private shouldExclude(
    filePath: string,
    rootPath: string,
    gitignoreSpec: ReturnType<typeof ignore> | null
  ): boolean {
    try {
      const relativePath = path.relative(rootPath, filePath);
      const pathStr = relativePath.replace(/\\/g, '/');

      // 检查 .gitignore 模式
      if (gitignoreSpec) {
        const isDir = fs.statSync(filePath).isDirectory();
        const testPath = isDir ? pathStr + '/' : pathStr;
        if (gitignoreSpec.ignores(testPath)) {
          logger.debug(`Excluded by .gitignore: ${testPath}`);
          return true;
        }
      }

      // 检查排除模式
      const pathParts = pathStr.split('/');
      for (const pattern of this.excludePatterns) {
        // 检查路径的每个部分
        for (const part of pathParts) {
          if (this.matchPattern(part, pattern)) {
            return true;
          }
        }
        // 检查完整路径
        if (this.matchPattern(pathStr, pattern)) {
          return true;
        }
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * 简单的模式匹配（支持 * 通配符）
   */
  private matchPattern(str: string, pattern: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
    const regex = new RegExp(`^${escaped}$`);
    return regex.test(str);
  }

  /**
   * 加载项目数据
   */
  private loadProjects(): Record<string, string[]> {
    if (!fs.existsSync(this.projectsFile)) {
      return {};
    }
    try {
      const content = fs.readFileSync(this.projectsFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      logger.error(`Failed to load projects data: ${error}`);
      return {};
    }
  }

  /**
   * 保存项目数据
   */
  private saveProjects(projects: Record<string, string[]>): void {
    const tmpFile = `${this.projectsFile}.tmp`;
    try {
      const content = JSON.stringify(projects, null, 2);
      fs.writeFileSync(tmpFile, content, 'utf-8');
      fs.renameSync(tmpFile, this.projectsFile);
    } catch (error) {
      logger.error(`Failed to save projects data: ${error}`);
      try { fs.unlinkSync(tmpFile); } catch {}
      throw error;
    }
  }

  /**
   * 将文件内容分割为多个 blob（如果需要）
   * 
   * 注意：保留换行符以确保与 Python 版本的 hash 一致
   * 正确处理 \r\n (Windows), \n (Unix), \r (旧Mac) 三种换行符
   */
  private splitFileContent(filePath: string, content: string): Blob[] {
    // 分割为行，保留换行符（模拟 Python 的 splitlines(keepends=True)）
    const lines: string[] = [];
    let start = 0;

    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') {
        // Unix 换行符 \n 或 Windows 换行符 \r\n 的结尾
        lines.push(content.substring(start, i + 1));
        start = i + 1;
      } else if (content[i] === '\r') {
        // 检查是否是 Windows 的 \r\n
        if (i + 1 < content.length && content[i + 1] === '\n') {
          // Windows 换行符 \r\n
          lines.push(content.substring(start, i + 2));
          start = i + 2;
          i++; // 跳过 \n
        } else {
          // 旧 Mac 换行符 \r（单独）
          lines.push(content.substring(start, i + 1));
          start = i + 1;
        }
      }
    }

    // 添加最后一行（如果有且不为空）
    if (start < content.length) {
      lines.push(content.substring(start));
    }

    const totalLines = lines.length;

    // 如果在限制内，返回单个 blob
    if (totalLines <= this.maxLinesPerBlob) {
      return [{ path: filePath, content }];
    }

    // 分割为多个 blob
    const blobs: Blob[] = [];
    const numChunks = Math.ceil(totalLines / this.maxLinesPerBlob);

    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      const startLine = chunkIdx * this.maxLinesPerBlob;
      const endLine = Math.min(startLine + this.maxLinesPerBlob, totalLines);
      const chunkLines = lines.slice(startLine, endLine);
      const chunkContent = chunkLines.join('');  // 直接连接，因为每行已经包含换行符

      // 添加 chunk 索引到路径
      const chunkPath = `${filePath}#chunk${chunkIdx + 1}of${numChunks}`;
      blobs.push({ path: chunkPath, content: chunkContent });
    }

    logger.info(`Split file ${filePath} (${totalLines} lines) into ${numChunks} chunks`);
    return blobs;
  }

  /**
   * 从项目目录收集所有文本文件
   */
  private async collectFiles(projectRootPath: string): Promise<Blob[]> {
    const blobs: Blob[] = [];
    let excludedCount = 0;
    
    // 规范化路径（移除末尾斜杠等）
    let rootPath = projectRootPath;
    // 移除末尾斜杠以确保 fs.existsSync 正常工作
    if (rootPath.endsWith('/') && rootPath.length > 1) {
      rootPath = rootPath.slice(0, -1);
    }
    if (rootPath.endsWith('\\') && rootPath.length > 3) {
      rootPath = rootPath.slice(0, -1);
    }

    // 检查路径是否存在
    if (!fs.existsSync(rootPath)) {
      logger.error(`Path check failed: ${rootPath} (original: ${projectRootPath})`);
      throw new Error(`Project root path does not exist: ${projectRootPath}. Please check if the path is correct and accessible.`);
    }

    // 检查是否为目录
    const stats = fs.statSync(rootPath);
    if (!stats.isDirectory()) {
      throw new Error(`Project root path is not a directory: ${projectRootPath}`);
    }

    // 加载 .gitignore
    const gitignoreSpec = this.loadGitignore(rootPath);

    /**
     * 递归遍历目录
     */
    const walkDir = async (dirPath: string): Promise<void> => {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          // 对于目录，在进入前检查是否应该排除（性能优化）
          if (!this.shouldExclude(fullPath, rootPath, gitignoreSpec)) {
            await walkDir(fullPath);
          } else {
            excludedCount++;
            logger.debug(`Excluded directory: ${path.relative(rootPath, fullPath)}`);
          }
        } else if (entry.isFile()) {
          // 检查文件是否应该排除
          if (this.shouldExclude(fullPath, rootPath, gitignoreSpec)) {
            excludedCount++;
            logger.debug(`Excluded file: ${path.relative(rootPath, fullPath)}`);
            continue;
          }
          const ext = path.extname(entry.name).toLowerCase();
          if (!this.textExtensions.has(ext)) {
            continue;
          }

          try {
            const relativePath = path.relative(rootPath, fullPath);
            
            // 检查相对路径是否有效（防止符号链接指向外部）
            if (relativePath.startsWith('..')) {
              logger.warning(`Skipping file outside project root: ${fullPath}`);
              continue;
            }
            
            const content = await readFileWithEncoding(fullPath);

            // 分割文件（如果需要）
            const fileBlobs = this.splitFileContent(relativePath, content);
            blobs.push(...fileBlobs);

            logger.debug(`Collected file: ${relativePath} (${fileBlobs.length} blob(s))`);
          } catch (error) {
            logger.warning(`Failed to read file: ${fullPath} - ${error}`);
            continue;
          }
        }
      }
    };

    await walkDir(rootPath);

    logger.info(
      `Collected ${blobs.length} blobs from ${projectRootPath} (excluded ${excludedCount} files/directories)`
    );
    return blobs;
  }

  /**
   * 使用指数退避策略重试请求
   */
  private async retryRequest<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    retryDelay: number = 1000
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        const isRetryable =
          error.code === 'ECONNREFUSED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND' ||
          (error.response && error.response.status >= 500);

        if (!isRetryable || attempt === maxRetries - 1) {
          logger.error(`Request failed after ${attempt + 1} attempts: ${error.message}`);
          throw error;
        }

        const waitTime = retryDelay * Math.pow(2, attempt);
        logger.warning(
          `Request failed (attempt ${attempt + 1}/${maxRetries}): ${error.message}. Retrying in ${waitTime}ms...`
        );
        await sleep(waitTime);
      }
    }

    throw lastError || new Error('All retries failed');
  }

  /**
   * 对代码项目进行索引（支持增量索引）
   */
  async indexProject(projectRootPath: string): Promise<IndexResult> {
    const normalizedPath = this.normalizePath(projectRootPath);
    logger.info(`Indexing project from ${normalizedPath}`);

    try {
      const blobs = await this.collectFiles(projectRootPath);

      if (blobs.length === 0) {
        return { status: 'error', message: 'No text files found in project' };
      }

      // 加载已存在的项目数据
      const projects = this.loadProjects();
      const existingBlobNames = new Set(projects[normalizedPath] || []);

      // 为所有收集的 blob 计算哈希值
      const blobHashMap = new Map<string, Blob>();
      for (const blob of blobs) {
        const blobHash = calculateBlobName(blob.path, blob.content);
        blobHashMap.set(blobHash, blob);
      }

      // 将 blob 分为已存在的和新的
      const allBlobHashes = new Set(blobHashMap.keys());
      const existingHashes = new Set(
        [...allBlobHashes].filter((hash) => existingBlobNames.has(hash))
      );
      const newHashes = [...allBlobHashes].filter((hash) => !existingBlobNames.has(hash));

      // 待上传的 blob
      const blobsToUpload = newHashes.map((hash) => blobHashMap.get(hash)!);

      logger.info(
        `Incremental indexing: total=${blobs.length}, existing=${existingHashes.size}, new=${newHashes.length}, to_upload=${blobsToUpload.length}`
      );

      // 只上传新的 blob
      const uploadedBlobNames: string[] = [];
      const failedBatches: number[] = [];

      if (blobsToUpload.length > 0) {
        const totalBatches = Math.ceil(blobsToUpload.length / this.batchSize);
        logger.info(
          `Uploading ${blobsToUpload.length} new blobs in ${totalBatches} batches (batch_size=${this.batchSize})`
        );

        for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
          const startIdx = batchIdx * this.batchSize;
          const endIdx = Math.min(startIdx + this.batchSize, blobsToUpload.length);
          const batchBlobs = blobsToUpload.slice(startIdx, endIdx);

          logger.info(`Uploading batch ${batchIdx + 1}/${totalBatches} (${batchBlobs.length} blobs)`);

          try {
            const uploadBatch = async () => {
              const response = await this.httpClient.post(`${this.baseUrl}/batch-upload`, {
                blobs: batchBlobs,
              }, { timeout: 120000 });
              return response.data;
            };

            const result = await this.retryRequest(uploadBatch, 3, 1000);

            const batchBlobNames = result.blob_names || [];
            if (batchBlobNames.length === 0) {
              logger.warning(`Batch ${batchIdx + 1} returned no blob names`);
              failedBatches.push(batchIdx + 1);
              continue;
            }

            uploadedBlobNames.push(...batchBlobNames);
            logger.info(
              `Batch ${batchIdx + 1} uploaded successfully, got ${batchBlobNames.length} blob names`
            );
          } catch (error: any) {
            logger.error(
              `Batch ${batchIdx + 1} failed after retries: ${error.message}. Continuing with next batch...`
            );
            failedBatches.push(batchIdx + 1);
            continue;
          }
        }

        if (uploadedBlobNames.length === 0 && blobsToUpload.length > 0) {
          // 判断项目是否已经初始化过（有旧数据）
          const isInitialized = existingHashes.size > 0;
          
          if (!isInitialized) {
            // 未初始化的新项目，所有批次失败返回错误
            if (failedBatches.length > 0) {
              return {
                status: 'error',
                message: `All batches failed on first indexing. Failed batches: ${failedBatches.join(', ')}`,
              };
            }
            return { status: 'error', message: 'No blob names returned from API on first indexing' };
          } else {
            // 已初始化的项目，即使此次上传全部失败也不影响使用
            logger.warning(
              `Project ${normalizedPath} has ${existingHashes.size} existing blobs. Current upload failed but project can still be used with existing data.`
            );
            // 继续执行，使用已有的 blob 数据
          }
        }
      } else {
        logger.info('No new blobs to upload, all blobs already exist in index');
      }

      // 合并已存在的和新上传的 blob 名称
      const allBlobNames = [...existingHashes, ...uploadedBlobNames];

      // 更新 projects.json
      projects[normalizedPath] = allBlobNames;
      this.saveProjects(projects);

      // 构建结果消息
      let message: string;
      if (blobsToUpload.length > 0) {
        const totalBatches = Math.ceil(blobsToUpload.length / this.batchSize);
        const successBatches = totalBatches - failedBatches.length;
        message = `Project indexed with ${allBlobNames.length} total blobs (existing: ${existingHashes.size}, new: ${uploadedBlobNames.length}, batches: ${successBatches}/${totalBatches} successful)`;
      } else {
        message = `Project indexed with ${allBlobNames.length} total blobs (all existing, no upload needed)`;
      }

      if (failedBatches.length > 0) {
        message += `. Failed batches: ${failedBatches.join(', ')}`;
        logger.warning(`Project ${normalizedPath} indexed with some failures: ${message}`);
      } else {
        logger.info(`Project ${normalizedPath} indexed successfully: ${message}`);
      }

      return {
        status: failedBatches.length === 0 ? 'success' : 'partial_success',
        message,
        project_path: normalizedPath,
        failed_batches: failedBatches,
        stats: {
          total_blobs: allBlobNames.length,
          existing_blobs: existingHashes.size,
          new_blobs: uploadedBlobNames.length,
          skipped_blobs: existingHashes.size,
        },
      };
    } catch (error: any) {
      logger.error(`Failed to index project ${normalizedPath}: ${error.message}`);
      return { status: 'error', message: error.message };
    }
  }

  /**
   * 搜索代码上下文（自动增量索引）
   */
  async searchContext(projectRootPath: string, query: string): Promise<string> {
    const normalizedPath = this.normalizePath(projectRootPath);
    logger.info(`Searching context in project ${normalizedPath} with query: ${query}`);

    try {
      // 步骤 1: 自动索引
      logger.info(`Auto-indexing project ${normalizedPath} before search...`);
      const indexResult = await this.indexProject(projectRootPath);

      if (indexResult.status === 'error') {
        return `Error: Failed to index project before search. ${indexResult.message}`;
      }

      // 记录索引统计信息
      if (indexResult.stats) {
        logger.info(
          `Auto-indexing completed: total=${indexResult.stats.total_blobs}, existing=${indexResult.stats.existing_blobs}, new=${indexResult.stats.new_blobs}`
        );
      }

      // 步骤 2: 加载已索引的 blob 名称
      const projects = this.loadProjects();
      const blobNames = projects[normalizedPath] || [];

      if (blobNames.length === 0) {
        return `Error: No blobs found for project ${normalizedPath} after indexing.`;
      }

      // 步骤 3: 执行搜索
      logger.info(`Performing search with ${blobNames.length} blobs...`);
      const payload = {
        information_request: query,
        blobs: {
          checkpoint_id: null,
          added_blobs: blobNames,
          deleted_blobs: [],
        },
        dialog: [],
        max_output_length: 0,
        disable_codebase_retrieval: false,
        enable_commit_retrieval: false,
      };

      const searchRequest = async () => {
        // 使用 httpClient 确保配置一致性
        const response = await this.httpClient.post(
          `${this.baseUrl}/agents/codebase-retrieval`,
          payload,
          {
            timeout: 60000,  // 搜索请求使用更长的超时时间
          }
        );
        return response.data;
      };

      let result: any;
      try {
        result = await this.retryRequest(searchRequest, 3, 2000);
      } catch (error: any) {
        const detail = error.response?.data ? ` Server response: ${JSON.stringify(error.response.data)}` : '';
        logger.error(`Search request failed after retries: ${error.message}${detail}`);
        return `Error: Search request failed after 3 retries. ${error.message}${detail}`;
      }

      const formattedRetrieval = result.formatted_retrieval || '';

      if (!formattedRetrieval) {
        logger.warning(`Search returned empty result for project ${normalizedPath}`);
        return 'No relevant code context found for your query.';
      }

      logger.info(`Search completed for project ${normalizedPath}`);
      return formattedRetrieval;
    } catch (error: any) {
      logger.error(`Failed to search context in project ${normalizedPath}: ${error.message}`);
      return `Error: ${error.message}`;
    }
  }
}

