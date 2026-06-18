import { OrchestratorConfig, AuthMode } from '../types';

/**
 * 调度器专用客户端：直连「Anthropic Messages API 协议」端点（手写 fetch，不走 SDK）
 *
 * 关键认知：依赖的是 *协议格式*，不绑定 Anthropic 官方。
 *   baseURL 指向任意兼容网关（LiteLLM / claude-code-router 等）即可用别家模型
 *   （OpenAI、DeepSeek、本地模型…）来驱动调度器。
 *
 * 为什么调度器要手写 fetch 而非用 Vercel AI SDK：
 *   调度器需要的是**可解析的结构化 JSON**（计划 / 决策），
 *   一次 request / 一次 response，不需要 tool loop、不需要流式，最朴素的 fetch 最稳定。
 *
 * 执行/验收任务则相反——要 tool loop + 工具调用，由 AgentEngine 用 Vercel AI SDK 实现。
 */
export class AnthropicClient {
  private baseURL: string;
  private apiKey: string;
  private modelId: string;
  private maxTokens: number;
  private authMode: AuthMode;

  constructor(config: OrchestratorConfig) {
    this.baseURL = (config.baseURL || 'https://api.anthropic.com').replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.modelId = config.modelId;
    this.maxTokens = config.maxTokens || 8192;

    // 鉴权方式：显式优先；否则按是否官方域名推断
    this.authMode =
      config.authMode || (/(^|\.)anthropic\.com$/i.test(new URL(this.baseURL).hostname) ? 'api-key' : 'bearer');

    if (!this.apiKey || this.apiKey.includes('在这里')) {
      throw new Error(
        '调度器 apiKey 未配置。请在 src/config/models.json 的 orchestrator.apiKey 填入真实密钥（官方 key 或网关令牌）。'
      );
    }
  }

  /**
   * 发送一次补全请求，返回纯文本响应
   *
   * @param systemPrompt 系统提示（角色设定）
   * @param userPrompt   用户消息（实际请求内容）
   */
  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (this.authMode === 'bearer') {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    } else {
      headers['x-api-key'] = this.apiKey;
    }

    const res = await fetch(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.modelId,
        max_tokens: this.maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`调度器 API 调用失败 (${res.status}): ${errBody}`);
    }

    const data: any = await res.json();

    // content 是 block 数组，提取所有 text block 拼接
    const text = Array.isArray(data.content)
      ? data.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('')
      : '';

    if (!text) {
      throw new Error(`调度器 API 返回空内容: ${JSON.stringify(data)}`);
    }

    return text;
  }

  get model(): string {
    return this.modelId;
  }
}
