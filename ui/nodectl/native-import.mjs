export async function importMissingNodes(api, entries, existingNodes) {
  if (typeof api?.post !== 'function' || !Array.isArray(entries) || !Array.isArray(existingNodes)) throw new Error('妙妙屋X原生导入接口不兼容，未写入节点');
  const existing = new Set(existingNodes.map(node => node.raw_url).filter(Boolean));
  const pending = [];
  let skipped = 0;
  for (const entry of entries) {
    if (existing.has(entry.url)) { skipped += 1; continue; }
    const parsed = await api.post('§46a7672619bac609', { content: entry.url, force_node_skip_cert: false });
    const proxies = parsed?.data?.proxies;
    if (!Array.isArray(proxies) || proxies.length !== 1 || !proxies[0]?.type || !proxies[0]?.server) throw new Error('节点解析结果不兼容，未写入任何节点');
    const proxy = proxies[0];
    const name = proxy.name || `${entry.server} · ${entry.protocol}`;
    const configuration = { ...proxy, name };
    const tag = `NodeCTL:${entry.uuid}`;
    pending.push({ raw_url: entry.url, node_name: name, protocol: proxy.type, parsed_config: JSON.stringify(configuration), clash_config: JSON.stringify(configuration), enabled: true, tag, tags: [tag] });
    existing.add(entry.url);
  }
  if (!pending.length) return { imported: 0, skipped };
  const saved = await api.post('§a096b479adc7fa16', { nodes: pending });
  if (!Array.isArray(saved?.data?.nodes) || saved.data.nodes.length !== pending.length) throw new Error('保存结果未完整确认，请刷新原节点列表后再重试；不要假定没有写入');
  return { imported: saved.data.nodes.length, skipped };
}
