/**
 * 日志系统，兼容 Python loguru 格式
 * 支持带颜色的控制台输出和文件日志轮转
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 日志级别
 */
export enum LogLevel {
  DEBUG = 10,
  INFO = 20,
  WARNING = 30,
  ERROR = 40,
}

/**
 * 控制台输出的 ANSI 颜色代码
 */
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

/**
 * 日志消息接口
 */
interface LogMessage {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context?: string;
}

/**
 * 日志器配置
 */
interface LoggerConfig {
  consoleLevel: LogLevel;
  fileLevel: LogLevel;
  logDir: string;
  maxFileSize: number; // in bytes
  maxFiles: number;
  enableConsole: boolean; // 是否启用控制台输出
}

/**
 * 自定义日志器，支持控制台和文件输出
 */
class Logger {
  private config: LoggerConfig;
  private logFile: string;
  private fileStream?: fs.WriteStream;
  private broadcastHandlers: Array<(message: string) => void> = [];
  private writeCount = 0;
  private static instance?: Logger;

  constructor(config?: Partial<LoggerConfig>) {
    const defaultConfig: LoggerConfig = {
      consoleLevel: LogLevel.INFO,
      fileLevel: LogLevel.DEBUG,
      logDir: path.join(os.homedir(), '.acemcp', 'log'),
      maxFileSize: 5 * 1024 * 1024, // 5MB
      maxFiles: 10,
      enableConsole: false, // 默认禁用控制台输出（MCP stdio 模式）
    };

    this.config = { ...defaultConfig, ...config };
    this.logFile = path.join(this.config.logDir, 'acemcp.log');
    this.ensureLogDir();
    this.initFileStream();
  }

  /**
   * 获取单例实例
   */
  static getInstance(config?: Partial<LoggerConfig>): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(config);
    }
    return Logger.instance;
  }

  /**
   * 更新现有实例的配置
   */
  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 确保日志目录存在
   */
  private ensureLogDir(): void {
    if (!fs.existsSync(this.config.logDir)) {
      fs.mkdirSync(this.config.logDir, { recursive: true });
    }
  }

  /**
   * 初始化文件流
   */
  private initFileStream(): void {
    this.checkRotation();
    this.fileStream = fs.createWriteStream(this.logFile, { flags: 'a', encoding: 'utf-8' });
  }

  /**
   * 检查日志文件是否需要轮转
   */
  private checkRotation(): void {
    if (!fs.existsSync(this.logFile)) {
      return;
    }

    const stats = fs.statSync(this.logFile);
    if (stats.size >= this.config.maxFileSize) {
      this.rotateLog();
    }
  }

  /**
   * 轮转日志文件
   */
  private rotateLog(): void {
    if (this.fileStream) {
      this.fileStream.end();
    }

    // Rotate existing files
    for (let i = this.config.maxFiles - 1; i >= 1; i--) {
      const oldFile = `${this.logFile}.${i}`;
      const newFile = `${this.logFile}.${i + 1}`;
      if (fs.existsSync(oldFile)) {
        if (i === this.config.maxFiles - 1) {
          fs.unlinkSync(oldFile); // Delete oldest
        } else {
          fs.renameSync(oldFile, newFile);
        }
      }
    }

    // Move current log to .1
    if (fs.existsSync(this.logFile)) {
      fs.renameSync(this.logFile, `${this.logFile}.1`);
    }
  }

  /**
   * 格式化时间戳
   */
  private formatTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * 获取日志级别名称
   */
  private getLevelName(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG:
        return 'DEBUG';
      case LogLevel.INFO:
        return 'INFO';
      case LogLevel.WARNING:
        return 'WARNING';
      case LogLevel.ERROR:
        return 'ERROR';
      default:
        return 'UNKNOWN';
    }
  }

  /**
   * 获取日志级别颜色
   */
  private getLevelColor(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG:
        return colors.gray;
      case LogLevel.INFO:
        return colors.blue;
      case LogLevel.WARNING:
        return colors.yellow;
      case LogLevel.ERROR:
        return colors.red;
      default:
        return colors.reset;
    }
  }

  /**
   * 记录日志消息
   */
  private log(level: LogLevel, message: string, context?: string): void {
    const timestamp = new Date();
    const levelName = this.getLevelName(level).padEnd(8);

    // 控制台输出（仅在启用时，并输出到 stderr 以避免污染 MCP stdio）
    if (this.config.enableConsole && level >= this.config.consoleLevel) {
      const timeStr = `${colors.green}${this.formatTimestamp(timestamp)}${colors.reset}`;
      const levelColor = this.getLevelColor(level);
      const levelStr = `${levelColor}${levelName}${colors.reset}`;
      const msgStr = `${levelColor}${message}${colors.reset}`;
      // 使用 stderr 而不是 stdout，避免污染 MCP 的 stdio 通信
      process.stderr.write(`${timeStr} | ${levelStr} | ${msgStr}\n`);
    }

    // 文件输出
    if (level >= this.config.fileLevel && this.fileStream) {
      const logLine = `${this.formatTimestamp(timestamp)} | ${levelName} | ${context || ''} - ${message}\n`;
      this.fileStream.write(logLine);
      this.writeCount++;
      if (this.writeCount % 100 === 0) {
        this.checkRotation();
      }
    }

    // 广播到 WebSocket 客户端
    if (level >= LogLevel.INFO) {
      const broadcastMsg = `${this.formatTimestamp(timestamp)} | ${levelName.trim()} | ${message}`;
      this.broadcastHandlers.forEach((handler) => {
        try {
          handler(broadcastMsg);
        } catch (err) {
          // 忽略广播错误
        }
      });
    }
  }

  /**
   * 添加 WebSocket 广播处理器
   */
  addBroadcastHandler(handler: (message: string) => void): void {
    this.broadcastHandlers.push(handler);
  }

  /**
   * 移除广播处理器
   */
  removeBroadcastHandler(handler: (message: string) => void): void {
    const index = this.broadcastHandlers.indexOf(handler);
    if (index > -1) {
      this.broadcastHandlers.splice(index, 1);
    }
  }

  /**
   * Debug 级别日志
   */
  debug(message: string, context?: string): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  /**
   * Info 级别日志
   */
  info(message: string, context?: string): void {
    this.log(LogLevel.INFO, message, context);
  }

  /**
   * Warning 级别日志
   */
  warning(message: string, context?: string): void {
    this.log(LogLevel.WARNING, message, context);
  }

  /**
   * Error 级别日志
   */
  error(message: string, context?: string): void {
    this.log(LogLevel.ERROR, message, context);
  }

  /**
   * 记录异常及堆栈跟踪
   */
  exception(message: string, error: Error, context?: string): void {
    const errorMsg = `${message}: ${error.message}\n${error.stack || ''}`;
    this.log(LogLevel.ERROR, errorMsg, context);
  }

  /**
   * 关闭日志器并清理资源
   */
  close(): void {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = undefined;
    }
  }
}

// 导出单例实例
export const logger = Logger.getInstance();

/**
 * 设置日志配置
 */
export function setupLogging(config?: Partial<LoggerConfig>): Logger {
  const instance = Logger.getInstance();
  if (config) {
    instance.configure(config);
  }
  instance.info('Logging configured');
  return instance;
}

