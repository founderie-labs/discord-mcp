// Vercel serverless entry. `npm run build` compiles src/ to dist/ first (see vercel.json).
import { handleMcpRequest } from "../dist/http.js";

export default async function handler(req, res) {
  await handleMcpRequest(req, res, req.body);
}

export const config = { maxDuration: 30 };
