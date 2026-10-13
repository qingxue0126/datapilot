import type { Request, Response } from "express";
import { AuthError } from "./account-store.js";
export const AUTH_COOKIE = "datapilot_session";

export function sessionToken(request: Request) {
  const cookies = Object.fromEntries((request.header("cookie") || "").split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part.trim(), ""] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
  return cookies[AUTH_COOKIE];
}

export function setSessionCookie(response: Response, token: string) {
  response.cookie(AUTH_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 7 * 24 * 60 * 60 * 1000 });
}
export function clearSessionCookie(response: Response) {
  response.clearCookie(AUTH_COOKIE, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
}
export function authFailure(response: Response, error: unknown) {
  const status = error instanceof AuthError ? error.status : 500;
  const message = error instanceof Error ? error.message : "认证服务异常";
  response.status(status).json({ error: status === 500 ? "认证服务异常" : message });
}
