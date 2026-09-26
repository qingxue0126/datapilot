export type ModelOption = {
  id: string;
  name: string;
  provider: string;
  description: string;
  capabilities: string[];
};

export function ModelSelector({ models, value, onChange }: { models: ModelOption[]; value: string; onChange: (id: string) => void }) {
  return <label className="model-selector">
    <span>模型</span>
    <select aria-label="选择模型" value={value} onChange={(event) => onChange(event.target.value)}>
      {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
    </select>
  </label>;
}

export function ModelManagement({ models, selectedModel, configured, onSelect }: { models: ModelOption[]; selectedModel: string; configured: boolean; onSelect: (id: string) => void }) {
  return <div className="module-content model-management-page">
    <div className="module-heading"><div><span className="eyebrow">MODEL REGISTRY</span><h2>模型管理</h2><p>管理 DataPilot 智能问数使用的模型，并设置当前默认模型。</p></div></div>
    <div className={`model-service-status ${configured ? "ready" : "warning"}`}><span />{configured ? "DeepSeek 服务已配置" : "尚未配置 DEEPSEEK_API_KEY，模型调用暂不可用"}</div>
    <section className="model-list-section"><header><div><h3>可用模型</h3><p>模型清单由服务端环境变量 DEEPSEEK_MODELS 控制。</p></div><small>{models.length} 个模型</small></header>
      <div className="model-grid">{models.map((model) => <article className={`model-card ${selectedModel === model.id ? "selected" : ""}`} key={model.id}>
        <div className="model-card-icon">◇</div><div className="model-card-copy"><div><h3>{model.name}</h3>{selectedModel === model.id && <span>当前模型</span>}</div><code>{model.id}</code><p>{model.description}</p><div>{model.capabilities.map((item) => <small key={item}>{item}</small>)}</div></div>
        <footer><span>{model.provider}</span><button onClick={() => onSelect(model.id)} disabled={selectedModel === model.id}>{selectedModel === model.id ? "已选择" : "设为默认"}</button></footer>
      </article>)}</div>
    </section>
  </div>;
}
