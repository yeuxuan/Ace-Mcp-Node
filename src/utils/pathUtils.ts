/**
 * 路径处理工具 - 跨平台和 WSL 兼容
 */

import path from 'path';
import { logger } from '../logger.js';

/**
 * 规范化项目路径，支持 WSL 和跨平台兼容性
 * 
 * 处理以下路径格式：
 * - Windows: C:\Users\... -> C:/Users/...
 * - WSL 内部: /home/user/... (保持不变)
 * - WSL->Windows: /mnt/c/Users/... (保持不变)
 * - Windows->WSL: \\wsl$\Ubuntu\home\... -> /home/...
 * 
 * @param filePath - 输入路径
 * @returns 规范化后的路径（统一使用正斜杠）
 * @throws {Error} 当路径为空或无效时抛出错误
 */
export function normalizeProjectPath(filePath: string): string {
  // 输入验证
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Path cannot be null or undefined');
  }

  const trimmedPath = filePath.trim();
  if (trimmedPath === '') {
    throw new Error('Path cannot be empty');
  }

  // 处理 Windows 访问 WSL 的 UNC 路径：\\wsl$\distribution\path
  if (trimmedPath.startsWith('\\\\wsl$\\') || trimmedPath.startsWith('//wsl$/')) {
    // 提取 WSL 分发版后的路径部分
    // \\wsl$\Ubuntu\home\user -> /home/user
    const parts = trimmedPath.replace(/\\/g, '/').split('/').filter(Boolean);
    
    if (parts.length < 3 || parts[0] !== 'wsl$') {
      // 不完整的 WSL 路径，记录警告并回退
      logger.warning(`Incomplete WSL UNC path: ${filePath}, falling back to standard resolution`);
      return path.resolve(trimmedPath).replace(/\\/g, '/');
    }
    
    // 跳过 "wsl$" 和分发版名称，保留后面的路径
    const wslPath = '/' + parts.slice(2).join('/');
    logger.debug(`Converted Windows WSL UNC path: ${filePath} -> ${wslPath}`);
    return wslPath;
  }

  // 处理 WSL 内部路径或 /mnt/c/... 路径
  if (trimmedPath.startsWith('/')) {
    // 特殊处理：在 Windows 环境下运行时，自动转换 /mnt/x/ 路径为 Windows 路径
    if (process.platform === 'win32' && trimmedPath.startsWith('/mnt/')) {
      const match = trimmedPath.match(/^\/mnt\/([a-z])\/(.*)/);
      if (match) {
        const drive = match[1].toUpperCase();
        const rest = match[2];
        const windowsPath = `${drive}:/${rest}`;
        logger.info(`Auto-converted WSL path to Windows: ${trimmedPath} -> ${windowsPath}`);
        
        // 移除末尾斜杠
        let normalized = windowsPath;
        if (normalized.length > 3 && normalized.endsWith('/')) {
          normalized = normalized.slice(0, -1);
        }
        return normalized;
      }
    }
    
    // Unix 风格路径，直接规范化分隔符并移除末尾斜杠
    let normalized = trimmedPath.replace(/\\/g, '/');
    // 移除末尾的斜杠（但保留根目录的斜杠）
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }

  // 处理 Windows 路径或相对路径（使用 path.resolve 转换为绝对路径）
  let normalized = path.resolve(trimmedPath).replace(/\\/g, '/');
  // 移除末尾的斜杠（Windows 盘符根目录除外，如 C:/）
  if (normalized.length > 3 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * 检查路径是否为有效的项目路径
 * 
 * @param filePath - 要检查的路径
 * @returns 如果路径有效返回 true
 */
export function isValidProjectPath(filePath: string): boolean {
  try {
    const normalized = normalizeProjectPath(filePath);
    // 检查是否为绝对路径
    return path.isAbsolute(normalized);
  } catch (error) {
    return false;
  }
}

