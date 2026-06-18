import { ModelsConfig, ModelEntry, ModelTier, AuthMode } from '../types';

/**
 * 解析后的最终模型信息
 * 由 ModelEntry（模型条目）+ ProviderConfig（供应商）合并而来
 */
export interface ResolvedModel {
  /** 模型条目 id（对应 ModelEntry.id） */
  id: string;
  tier: ModelTier;
  provider: string;
  /** 底层模型名，作为 model 字段传给 /v1/messages 请求 */
  modelId: string;
  /** Anthropic 兼容端点，注入 ANTHROPIC_BASE_URL */
  baseURL: string;
  /** 密钥 */
  apiKey: string;
  /** 鉴权方式，决定密钥写入哪个环境变量 */
  authMode: AuthMode;
  /** 该模型是否支持并发（缺省 true） */
  concurrent: boolean;
}

/** 给调度器看的模型清单条目（不含密钥等敏感信息） */
export interface ModelCatalogEntry {
  id: string;
  tier: ModelTier;
  concurrent: boolean;
  note?: string;
}

/**
 * 模型库注册表
 *
 * 配置主体是「模型清单」（ModelEntry[]），每个模型自带 tier 标注。
 * 调度器拿到清单（catalog）后，自己为每个任务挑选模型条目 id；
 * 运行时由这里把 id 解析成 provider + 底层模型名 + 鉴权信息。
 */
export class ModelRegistry {
  private byId: Map<string, ModelEntry> = new Map();

  constructor(private models: ModelsConfig) {
    this.validate();
    for (const m of this.models.models) {
      this.byId.set(m.id, m);
    }
  }

  /** 把一个模型条目 id 解析为最终可执行模型信息 */
  resolve(modelEntryId: string): ResolvedModel {
    const entry = this.byId.get(modelEntryId);
    if (!entry) {
      throw new Error(
        `模型库中没有 id 为 "${modelEntryId}" 的模型条目，请检查 models.json 的 models 或调度器的选择`
      );
    }

    const provider = this.models.providers[entry.provider];
    if (!provider) {
      throw new Error(
        `模型 "${entry.id}" 引用了未定义的供应商 "${entry.provider}"，请检查 models.json 的 providers`
      );
    }

    const authMode: AuthMode =
      provider.authMode || (entry.provider === 'claude' ? 'api-key' : 'bearer');

    return {
      id: entry.id,
      tier: entry.tier,
      provider: entry.provider,
      modelId: entry.modelId,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      authMode,
      concurrent: entry.concurrent !== false,
    };
  }

  /** 该模型条目是否支持并发 */
  isConcurrent(modelEntryId: string): boolean {
    return this.resolve(modelEntryId).concurrent;
  }

  /** 是否存在该模型条目 */
  has(modelEntryId: string): boolean {
    return this.byId.has(modelEntryId);
  }

  /**
   * 给调度器的可用模型清单（脱敏：不含端点/密钥）
   * 调度器据此为每个任务挑选合适的模型条目 id
   */
  catalog(): ModelCatalogEntry[] {
    return this.models.models.map((m) => ({
      id: m.id,
      tier: m.tier,
      concurrent: m.concurrent !== false,
      note: m.note,
    }));
  }

  /** 启动期校验：清单非空、id 唯一、引用的供应商都存在、key 已填 */
  private validate(): void {
    const list = this.models.models;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('models.json 的 models 清单为空，至少需要配置一个模型');
    }

    const seen = new Set<string>();
    for (const m of list) {
      if (!m.id) {
        throw new Error('models.json 存在缺少 id 的模型条目');
      }
      if (seen.has(m.id)) {
        throw new Error(`models.json 存在重复的模型条目 id "${m.id}"`);
      }
      seen.add(m.id);

      const p = this.models.providers?.[m.provider];
      if (!p) {
        throw new Error(`模型 "${m.id}" 引用的供应商 "${m.provider}" 未在 providers 中定义`);
      }
      if (!p.apiKey || p.apiKey.includes('在这里')) {
        throw new Error(
          `供应商 "${m.provider}" 的 apiKey 未配置，请在 models.json 填入真实 key（或本地网关占位）`
        );
      }
    }
  }
}
