const API = 'https://sos-backend-climey-production.up.railway.app';

async function consultarPlaca(placa) {
  const r = await fetch(`${API}/api/consulta/basica/${placa}`);
  if (!r.ok) throw new Error('Erro na consulta');
  return r.json();
}

async function consultarPlacaCompleta(placa, pagamentoId) {
  const r = await fetch(`${API}/api/consulta/completa/${placa}/${pagamentoId}`);
  if (!r.ok) throw new Error('Erro na consulta completa');
  return r.json();
}

async function criarPagamento(body) {
  const r = await fetch(`${API}/api/pagamento/criar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('Erro ao criar pagamento');
  return r.json();
}

async function statusPagamento(id) {
  const r = await fetch(`${API}/api/pagamento/status/${id}`);
  if (!r.ok) throw new Error('Erro ao verificar status');
  return r.json();
}

function logoUrl(url) {
  return `${API}/api/logo?url=${encodeURIComponent(url)}`;
}

window.SOS = { consultarPlaca, consultarPlacaCompleta, criarPagamento, statusPagamento, logoUrl };
