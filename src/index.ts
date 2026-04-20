#!/usr/bin/env node

/**
 * 代码库索引的 MCP 服务器
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'module';
import { initConfig, getConfig } from './config.js';
import { setupLogging, logger } from './logger.js';
import { searchContextTool } from './tools/searchContext.js';
import { createApp } from './web/app.js';

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require('../package.json');

/**
 * 解析命令行参数
 */
function parseArgs(): { baseUrl?: string; token?: string; webPort?: number } {
  const args = process.argv.slice(2);
  const result: { baseUrl?: string; token?: string; webPort?: number } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--base-url' && i + 1 < args.length) {
      result.baseUrl = args[i + 1];
      i++;
    } else if (arg === '--token' && i + 1 < args.length) {
      result.token = args[i + 1];
      i++;
    } else if (arg === '--web-port' && i + 1 < args.length) {
      const port = parseInt(args[i + 1], 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid --web-port value: "${args[i + 1]}". Must be a number between 1 and 65535.`);
      }
      result.webPort = port;
      i++;
    }
  }

  return result;
}

/**
 * 创建 MCP 服务器
 */
const server = new Server(
  {
    name: 'acemcp',
    version: pkgVersion,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * 列出可用工具
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [
    {
      name: 'search_context',
      description:
        'Semantically search a codebase to retrieve relevant code context. Use this tool whenever you need to understand, navigate, or reason about a codebase before making changes — it understands meaning, not just text, so queries like "how does authentication work" or "where are database connections managed" return the right code even without exact keyword matches. Automatically performs incremental indexing before each search so results always reflect the current state of the project. Returns formatted snippets with file paths and line numbers, ready to use in follow-up reasoning or edits. Supports Windows, Linux, macOS, and WSL paths.',
      inputSchema: {
        type: 'object',
        properties: {
          project_root_path: {
            type: 'string',
            description:
              'Absolute path to the project root directory. All common path formats are accepted and automatically normalized: Windows (C:/Users/...), WSL UNC (\\\\wsl$\\Ubuntu\\home\\...), Unix/macOS (/home/... or /Users/...), WSL-to-Windows (/mnt/c/...).',
          },
          query: {
            type: 'string',
            description:
              'Natural language description of the code you are looking for. Phrase it as a question or a concept rather than keywords — the engine understands intent. Good examples: "how is user authentication implemented", "database connection pool setup", "error handling and retry logic for API calls", "React components that manage form state", "where are environment variables loaded", "entry point and startup sequence". The tool returns formatted code snippets with file paths and line numbers.',
          },
        },
        required: ['project_root_path', 'query'],
      },
    },
  ];

  return { tools };
});

/**
 * 处理工具调用
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  logger.info(`Tool called: ${name} with arguments: ${JSON.stringify(args)}`);

  if (name === 'search_context') {
    const result = await searchContextTool(args as any);
    return {
      content: [
        {
          type: 'text',
          text: result.text,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `Unknown tool: ${name}`,
      },
    ],
  };
});

/**
 * 启动 Web 服务器
 */
async function startWebServer(port: number): Promise<void> {
  const http = await import('http');
  const { setupWebSocket } = await import('./web/app.js');
  
  const app = createApp();
  
  // 创建 HTTP 服务器
  const httpServer = http.createServer(app);
  
  // 启动服务器，添加错误处理
  return new Promise((resolve) => {
    // 必须在 listen() 之前注册错误处理器
    httpServer.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        logger.warning(`Port ${port} is already in use. Web interface will not start.`);
        logger.warning(`If another instance is running, you can access the web interface at http://localhost:${port}`);
        resolve(); // 优雅降级，不阻止 MCP 服务器启动
      } else {
        logger.error(`Failed to start web server: ${error.message}`);
        resolve(); // 即使其他错误也不阻止 MCP 服务器
      }
    });
    
    // 启动服务器
    httpServer.listen(port, '0.0.0.0', () => {
      logger.info(`Web management interface running on http://localhost:${port}`);
      
      // 只在 HTTP 服务器成功启动后才设置 WebSocket
      try {
        setupWebSocket(httpServer);
      } catch (error: any) {
        logger.error(`Failed to setup WebSocket: ${error.message}`);
      }
      
      resolve();
    });
  });
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  try {
    const { baseUrl, token, webPort } = parseArgs();

    // 如果启用了 Web 界面，先设置日志广播支持
    if (webPort) {
      // 初始化日志广播器
      const { getLogBroadcaster } = await import('./web/logBroadcaster.js');
      getLogBroadcaster();
    }

    // 初始化配置（先于日志，因为日志需要读取配置）
    const config = initConfig(baseUrl, token);
    config.validate();

    // 设置日志（使用配置中的参数）
    setupLogging({
      maxFileSize: config.logMaxFileSizeMB * 1024 * 1024,  // 转换为字节
      maxFiles: config.logMaxFiles,
    });

    logger.info('正在启动 acemcp MCP 服务器...');
    logger.info(
      `配置: index_storage_path=${config.indexStoragePath}, batch_size=${config.batchSize}`
    );
    logger.info(`API: base_url=${config.baseUrl}`);

    // 如果请求，启动 Web 服务器
    if (webPort) {
      logger.info(`正在启动 Web 管理界面，端口 ${webPort}`);
      await startWebServer(webPort);
    }

    // 在 stdio 上启动 MCP 服务器
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('MCP 服务器已通过 stdio 连接');
  } catch (error: any) {
    logger.exception('Server error', error);
    process.exit(1);
  }
}

// 运行主函数
main().catch((error) => {
  console.error('致命错误:', error);
  process.exit(1);
});
