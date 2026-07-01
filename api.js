// Este arquivo fica dentro do <helmet>, então o runtime do Dora pode executá-lo
// duas vezes (uma no parse do HTML, outra ao reinjetar o <helmet> no <head>).
// Por isso é envolto numa IIFE idempotente — sem nenhum `const` global que
// pudesse lançar "Identifier already declared" na segunda execução.
(function () {
  if (window.SOS) return; // já inicializado — segunda execução é no-op

  window.SOS_API = window.SOS_API || 'https://bp-sos-production.up.railway.app';

  async function consultarPlaca(placa) {
    const r = await fetch(`${window.SOS_API}/api/consulta/basica/${placa}`);
    if (!r.ok) throw new Error('Erro na consulta');
    return r.json();
  }

  async function consultarPlacaCompleta(placa, pagamentoId) {
    const r = await fetch(`${window.SOS_API}/api/consulta/completa/${placa}/${pagamentoId}`);
    if (!r.ok) throw new Error('Erro na consulta completa');
    return r.json();
  }

  async function criarPagamento(body) {
    const r = await fetch(`${window.SOS_API}/api/pagamento/criar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('Erro ao criar pagamento');
    return r.json();
  }

  async function statusPagamento(id) {
    const r = await fetch(`${window.SOS_API}/api/pagamento/status/${id}`);
    if (!r.ok) throw new Error('Erro ao verificar status');
    return r.json();
  }

  function logoUrl(url) {
    return `${window.SOS_API}/api/logo?url=${encodeURIComponent(url)}`;
  }

  window.SOS = { consultarPlaca, consultarPlacaCompleta, criarPagamento, statusPagamento, logoUrl };
})();
