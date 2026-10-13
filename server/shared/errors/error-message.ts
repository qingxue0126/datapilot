/** Keep the existing public error text and secret-limiting length across HTTP entry points. */
export function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (/access denied/i.test(message)) return "数据库用户名或密码错误";
  if (/private key|Cannot parse/i.test(message)) return "SSH 私钥无效或需要正确的私钥口令";
  if (/ECONNREFUSED|Timed out|timeout|ENOTFOUND/i.test(message)) return "无法连接数据库或 SSH 服务器，请检查地址、端口和网络";
  return message.slice(0, 300);
}
