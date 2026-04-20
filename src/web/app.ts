/**
 * MCP 服务器管理的 Express Web 应用
 */

import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import * as toml from '@iarna/toml';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { getLogBroadcaster } from './logBroadcaster.js';
import { searchContextTool, resetIndexManager } from '../tools/searchContext.js';
import { USER_CONFIG_FILE } from '../config.js';
import { IndexManager } from '../index/manager.js';
import { fileURLToPath } from 'url';
import { normalizeProjectPath } from '../utils/pathUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 配置更新接口
 */
interface ConfigUpdate {
  base_url?: string;
  token?: string;
  batch_size?: number;
  max_lines_per_blob?: number;
  text_extensions?: string[];
  exclude_patterns?: string[];
}

/**
 * 工具请求接口
 */
interface ToolRequest {
  tool_name: string;
  arguments: Record<string, any>;
}

/**
 * 创建 Express 应用
 */
export function createApp(): express.Application {
  const app = express();
  const logBroadcaster = getLogBroadcaster();

  // 中间件
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // 静态文件（如果存在）
  const staticDir = path.join(__dirname, 'static');
  if (fs.existsSync(staticDir)) {
    app.use('/static', express.static(staticDir));
  }

  /**
   * GET / - 提供主管理页面
   */
  app.get('/', (req: Request, res: Response) => {
    const htmlFile = path.join(__dirname, 'templates', 'index.html');
    if (fs.existsSync(htmlFile)) {
      res.sendFile(htmlFile);
    } else {
      res.send('<h1>Acemcp Management</h1><p>Template not found</p>');
    }
  });

  /**
   * GET /api/config - 获取当前配置
   */
  app.get('/api/config', (req: Request, res: Response) => {
    try {
      const config = getConfig();
      res.json({
        index_storage_path: config.indexStoragePath,
        batch_size: config.batchSize,
        max_lines_per_blob: config.maxLinesPerBlob,
        base_url: config.baseUrl,
        token: config.token ? '***' : '',
        text_extensions: Array.from(config.textExtensions),
        exclude_patterns: config.excludePatterns,
      });
    } catch (error: any) {
      logger.error(`Failed to get config: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/config - 更新配置
   */
  app.post('/api/config', async (req: Request, res: Response) => {
    try {
      const configUpdate: ConfigUpdate = req.body;

      if (!fs.existsSync(USER_CONFIG_FILE)) {
        return res.status(404).json({ detail: 'User configuration file not found' });
      }

      // 加载现有设置
      const content = fs.readFileSync(USER_CONFIG_FILE, 'utf-8');
      const settingsData: any = toml.parse(content);

      // 更新设置
      if (configUpdate.base_url !== undefined) {
        settingsData.BASE_URL = configUpdate.base_url;
      }
      if (configUpdate.token !== undefined && configUpdate.token !== '') {
        settingsData.TOKEN = configUpdate.token;
      }
      if (configUpdate.batch_size !== undefined) {
        settingsData.BATCH_SIZE = configUpdate.batch_size;
      }
      if (configUpdate.max_lines_per_blob !== undefined) {
        settingsData.MAX_LINES_PER_BLOB = configUpdate.max_lines_per_blob;
      }
      if (configUpdate.text_extensions !== undefined) {
        settingsData.TEXT_EXTENSIONS = configUpdate.text_extensions;
      }
      if (configUpdate.exclude_patterns !== undefined) {
        settingsData.EXCLUDE_PATTERNS = configUpdate.exclude_patterns;
      }

      // 保存设置（原子写入：先写临时文件再 rename，防止崩溃损坏配置）
      const newContent = toml.stringify(settingsData as any);
      const tmpConfig = `${USER_CONFIG_FILE}.tmp`;
      fs.writeFileSync(tmpConfig, newContent, 'utf-8');
      fs.renameSync(tmpConfig, USER_CONFIG_FILE);

      // 重新加载配置，并重置 IndexManager 使其下次调用时用新配置重建
      const config = getConfig();
      config.reload();
      resetIndexManager();

      logger.info('Configuration updated and reloaded successfully');
      res.json({ status: 'success', message: 'Configuration updated and applied successfully!' });
    } catch (error: any) {
      logger.exception('Failed to update configuration', error);
      res.status(500).json({ detail: `Failed to update configuration: ${error.message}` });
    }
  });

  /**
   * GET /api/status - 获取服务器状态
   */
  app.get('/api/status', (req: Request, res: Response) => {
    try {
      const config = getConfig();
      const projectsFile = path.join(config.indexStoragePath, 'projects.json');
      let projectCount = 0;

      if (fs.existsSync(projectsFile)) {
        try {
          const content = fs.readFileSync(projectsFile, 'utf-8');
          const projects = JSON.parse(content);
          projectCount = Object.keys(projects).length;
        } catch (error) {
          logger.error(`Failed to load projects: ${error}`);
        }
      }

      res.json({
        status: 'running',
        project_count: projectCount,
        storage_path: config.indexStoragePath,
      });
    } catch (error: any) {
      logger.error(`Failed to get status: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/projects/check - 检查项目是否已索引
   */
  app.post('/api/projects/check', (req: Request, res: Response) => {
    try {
      const { project_path } = req.body;
      
      if (!project_path) {
        return res.status(400).json({ error: 'project_path is required' });
      }
      
      const config = getConfig();
      const projectsFile = path.join(config.indexStoragePath, 'projects.json');
      
      // 规范化路径（统一使用正斜杠，支持 WSL）
      let normalizedPath: string;
      try {
        normalizedPath = normalizeProjectPath(project_path);
      } catch (error: any) {
        return res.status(400).json({ error: `Invalid project path: ${error.message}` });
      }
      
      if (!fs.existsSync(projectsFile)) {
        return res.json({
          indexed: false,
          blob_count: 0,
          normalized_path: normalizedPath,
        });
      }
      
      const content = fs.readFileSync(projectsFile, 'utf-8');
      const projects = JSON.parse(content);
      
      const blobNames = projects[normalizedPath] || [];
      
      res.json({
        indexed: blobNames.length > 0,
        blob_count: blobNames.length,
        normalized_path: normalizedPath,
      });
    } catch (error: any) {
      logger.error(`Failed to check project: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/projects - 获取所有已索引项目列表
   */
  app.get('/api/projects', (req: Request, res: Response) => {
    try {
      const config = getConfig();
      const projectsFile = path.join(config.indexStoragePath, 'projects.json');
      
      if (!fs.existsSync(projectsFile)) {
        return res.json({ projects: [] });
      }
      
      const content = fs.readFileSync(projectsFile, 'utf-8');
      const projects = JSON.parse(content);
      
      const projectList = Object.keys(projects).map(projectPath => ({
        path: projectPath,
        blob_count: projects[projectPath].length,
      }));
      
      res.json({ projects: projectList });
    } catch (error: any) {
      logger.error(`Failed to get projects: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/projects/reindex - 重新索引项目
   */
  app.post('/api/projects/reindex', async (req: Request, res: Response) => {
    try {
      const { project_path } = req.body;
      
      if (!project_path) {
        return res.status(400).json({ error: 'project_path is required' });
      }
      
      const config = getConfig();
      const indexManager = new IndexManager(
        config.indexStoragePath,
        config.baseUrl,
        config.token,
        config.textExtensions,
        config.batchSize,
        config.maxLinesPerBlob,
        config.excludePatterns
      );
      
      logger.info(`Starting reindex for project: ${project_path}`);
      
      const result = await indexManager.indexProject(project_path);
      
      res.json({
        success: true,
        message: 'Project reindexed successfully',
        result,
      });
    } catch (error: any) {
      logger.exception(`Failed to reindex project: ${error.message}`, error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * DELETE /api/projects/delete - 删除项目索引
   */
  app.delete('/api/projects/delete', (req: Request, res: Response) => {
    try {
      const { project_path } = req.body;
      
      if (!project_path) {
        return res.status(400).json({ error: 'project_path is required' });
      }
      
      const config = getConfig();
      const projectsFile = path.join(config.indexStoragePath, 'projects.json');
      
      // 规范化路径（支持 WSL）
      let normalizedPath: string;
      try {
        normalizedPath = normalizeProjectPath(project_path);
      } catch (error: any) {
        return res.status(400).json({ error: `Invalid project path: ${error.message}` });
      }
      
      if (!fs.existsSync(projectsFile)) {
        return res.status(404).json({ error: 'No indexed projects found' });
      }
      
      const content = fs.readFileSync(projectsFile, 'utf-8');
      const projects = JSON.parse(content);
      
      if (!projects[normalizedPath]) {
        return res.status(404).json({ error: 'Project not found in index' });
      }
      
      // 删除项目
      delete projects[normalizedPath];
      
      // 保存更新后的 projects.json（原子写入）
      const tmpProjects = `${projectsFile}.tmp`;
      fs.writeFileSync(tmpProjects, JSON.stringify(projects, null, 2), 'utf-8');
      fs.renameSync(tmpProjects, projectsFile);
      
      logger.info(`Deleted project index: ${normalizedPath}`);
      
      res.json({
        success: true,
        message: 'Project index deleted successfully',
        deleted_path: normalizedPath,
      });
    } catch (error: any) {
      logger.exception(`Failed to delete project: ${error.message}`, error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/projects/details - 获取项目详细信息
   */
  app.post('/api/projects/details', (req: Request, res: Response) => {
    try {
      const { project_path } = req.body;
      
      if (!project_path) {
        return res.status(400).json({ error: 'project_path is required' });
      }
      
      const config = getConfig();
      const projectsFile = path.join(config.indexStoragePath, 'projects.json');
      
      // 规范化路径（支持 WSL）
      let normalizedPath: string;
      try {
        normalizedPath = normalizeProjectPath(project_path);
      } catch (error: any) {
        return res.status(400).json({ error: `Invalid project path: ${error.message}` });
      }
      
      if (!fs.existsSync(projectsFile)) {
        return res.status(404).json({ error: 'No indexed projects found' });
      }
      
      const content = fs.readFileSync(projectsFile, 'utf-8');
      const projects = JSON.parse(content);
      
      if (!projects[normalizedPath]) {
        return res.status(404).json({ error: 'Project not found in index' });
      }
      
      const blobNames = projects[normalizedPath];
      
      // 统计文件类型分布 - 从实际项目目录扫描
      const fileTypeStats: Record<string, number> = {};
      let totalFiles = 0;
      
      if (fs.existsSync(normalizedPath) && fs.statSync(normalizedPath).isDirectory()) {
        // 递归扫描项目目录
        const scanDirectory = (dir: string) => {
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              
              // 跳过排除的目录
              if (entry.isDirectory()) {
                const shouldExclude = config.excludePatterns.some(pattern => {
                  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
                  return entry.name === pattern || new RegExp(`^${escaped}$`).test(entry.name);
                });
                
                if (!shouldExclude && !entry.name.startsWith('.')) {
                  scanDirectory(fullPath);
                }
              } else if (entry.isFile()) {
                // 统计文件类型
                const ext = path.extname(entry.name);
                if (ext && config.textExtensions.has(ext)) {
                  fileTypeStats[ext] = (fileTypeStats[ext] || 0) + 1;
                  totalFiles++;
                }
              }
            }
          } catch (error) {
            // 忽略无权限访问的目录
          }
        };
        
        scanDirectory(normalizedPath);
      }
      
      res.json({
        path: normalizedPath,
        blob_count: blobNames.length,
        file_count: totalFiles,
        file_type_stats: fileTypeStats,
        indexed: true,
      });
    } catch (error: any) {
      logger.exception(`Failed to get project details: ${error.message}`, error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/tools/execute - 执行工具进行调试
   */
  app.post('/api/tools/execute', async (req: Request, res: Response) => {
    try {
      const toolRequest: ToolRequest = req.body;
      const { tool_name, arguments: args } = toolRequest;

      logger.info(`Executing tool: ${tool_name} with arguments: ${JSON.stringify(args)}`);

      let result: any;

      if (tool_name === 'search_context') {
        result = await searchContextTool(args);
      } else {
        return res.json({ status: 'error', message: `Unknown tool: ${tool_name}` });
      }

      logger.info(`Tool ${tool_name} executed successfully`);
      res.json({ status: 'success', result });
    } catch (error: any) {
      logger.exception(`Failed to execute tool ${req.body.tool_name}`, error);
      res.json({ status: 'error', message: error.message });
    }
  });

  return app;
}

/**
 * 为日志设置 WebSocket 服务器
 */
export function setupWebSocket(server: any): void {
  const wss = new WebSocketServer({ server, path: '/ws/logs' });
  const logBroadcaster = getLogBroadcaster();

  // 添加 WebSocket 服务器错误处理
  wss.on('error', (error: any) => {
    logger.error(`WebSocket server error: ${error.message}`);
  });

  wss.on('connection', (ws: WebSocket) => {
    logBroadcaster.addClient(ws);
  });

  logger.info('WebSocket server setup completed');
}

