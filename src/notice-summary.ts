export const summarizeNotice = (notice: string): string => {
  if (notice.includes("os error 267")) {
    const service = notice.match(/^MCP 服务\s+([^\s]+)\s+启动失败/);
    return `${service ? `MCP 服务 ${service[1]}` : "服务"}无法启动：工作目录不存在或无效。请在会话设置中选择真实项目目录。`;
  }
  return notice.length > 240 ? `${notice.slice(0, 220)}…` : notice;
};
