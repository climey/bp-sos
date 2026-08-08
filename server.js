require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const https    = require('https');
const xml2js   = require('xml2js');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cors({
  origin: [
    'https://bp-sos.vercel.app',
    'https://sospc.vercel.app',
    'https://busca.sosbuscasonline.com.br',
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST'],
}));

// ─────────────────────────────────────────────────────────────────────────────
// BANCO DE DADOS (PostgreSQL) — persiste as consultas pagas p/ o "Já paguei".
// Só ativa se DATABASE_URL estiver setada (Railway → add PostgreSQL). Sem ela,
// o backend continua com o índice em memória (não quebra o deploy).
// Escape hatch de SSL: PGSSL=false se a conexão interna do Railway recusar SSL.
// ─────────────────────────────────────────────────────────────────────────────
let _pool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
      max: 5,
    });
    _pool.on('error', (e) => console.error('[db] pool error:', e.message));
    _pool.query(`CREATE TABLE IF NOT EXISTS consultas (
      chave TEXT PRIMARY KEY,
      placa TEXT,
      email TEXT,
      pagamento_id TEXT,
      dados JSONB,
      atualizado_em TIMESTAMPTZ DEFAULT now()
    )`).then(() => console.log('[db] tabela consultas pronta'))
       .catch((e) => console.error('[db] init falhou:', e.message));
  } catch (e) {
    console.error('[db] pg indisponível:', e.message);
    _pool = null;
  }
}

// Salva/atualiza a consulta paga (fire-and-forget; erros só logam).
async function dbSalvar(chave, placa, email, pagamentoId, dados) {
  if (!_pool || !chave || !dados) return;
  try {
    await _pool.query(
      `INSERT INTO consultas (chave, placa, email, pagamento_id, dados, atualizado_em)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (chave) DO UPDATE SET dados = EXCLUDED.dados,
         pagamento_id = EXCLUDED.pagamento_id, atualizado_em = now()`,
      [chave, placa || null, email || null, pagamentoId || null, JSON.stringify(dados)]
    );
  } catch (e) { console.error('[db] salvar:', e.message); }
}

// Busca a consulta paga por chave (placa|email). Retorna o `dados` (relatório) ou null.
async function dbBuscar(chave) {
  if (!_pool || !chave) return null;
  try {
    const r = await _pool.query('SELECT dados FROM consultas WHERE chave = $1', [chave]);
    return r.rows[0] ? r.rows[0].dados : null;
  } catch (e) { console.error('[db] buscar:', e.message); return null; }
}


// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function placaValida(placa) {
  return /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa.toUpperCase());
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers
    };
    https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Resposta inválida')); }
      });
    }).on('error', reject).end();
  });
}

// GET que retorna o corpo bruto (texto) — usado para respostas XML (BrasilCredit).
function httpGetText(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject).end();
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const urlObj  = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Resposta inválida')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function mpGet(path) {
  return httpGet(`https://api.mercadopago.com${path}`, {
    'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`
  });
}

function melhorFipe(dados) {
  const lista = dados.fipe?.dados;
  if (!lista?.length) return null;
  const best = lista.reduce((a, b) => b.score > a.score ? b : a, lista[0]);
  return {
    codigo:      best.codigo_fipe    || null,
    valor:       best.texto_valor    || null,
    modelo:      best.texto_modelo   || null,
    marca:       best.texto_marca    || null,
    combustivel: best.combustivel    || null,
    ano_modelo:  best.ano_modelo     || null,
    referencia:  best.mes_referencia || null,
    score:       best.score          || null
  };
}

// Monta a consulta premium unificada (wdapi2 básico + BrasilCredit), usada tanto
// pela rota POST /api/consulta/premium quanto pelo fluxo de pagamento aprovado.
const _premiumCache = new Map();   // pagamento_id -> resultado premium (em memória)
const _premiumPending = new Map();  // pagamento_id -> promise em andamento (premium)
const _leilaoPending = new Map();   // pagamento_id -> promise em andamento (leilão)

// Dispara uma computação em background e cacheia o resultado. Retorna o valor
// se já estiver pronto, ou null enquanto processa (NÃO bloqueia o request).
function bgCache(cache, pending, id, fn) {
  if (cache.has(id)) return cache.get(id);
  if (!pending.has(id)) {
    pending.set(id, Promise.resolve().then(fn)
      .then(r => { cache.set(id, r); pending.delete(id); return r; })
      .catch(e => { pending.delete(id); console.error('[bgCache]', e.message); return null; }));
  }
  return null; // ainda processando
}

// Helpers de parsing reutilizados pelos mapeadores BrasilCredit.
const pick = (...vals) => { for (const v of vals) { if (v != null && String(v).trim() !== '') return v; } return null; };
const arr  = (v) => (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]));
const obj  = (v) => (v && typeof v === 'object' ? v : {});

// IDs das consultas BrasilCredit (env). Estadual = base; sinistro/recall = upsells.
const BC_ESTADUAL = () => process.env.BRASIL_CREDIT_CONSULTA_ESTADUAL;
const BC_SINISTRO = () => process.env.BRASIL_CREDIT_CONSULTA_SINISTRO;
const BC_RECALL   = () => process.env.BRASIL_CREDIT_CONSULTA_RECALL;

// Monta a consulta premium unificada: wdapi2 básico + Base Estadual (BrasilCredit
// 575) como fonte premium, + sinistro/recall como consultas BrasilCredit SEPARADAS,
// disparadas só quando o respectivo upsell foi comprado (opts.sinistro/opts.recall).
// Requer a env BRASIL_CREDIT_CONSULTA_ESTADUAL. Retorna { basico, premium }.
async function montarConsultaPremium(placa, opts = {}) {
  const wdapiP = httpGet(`https://wdapi2.com.br/consulta/${placa}/${process.env.WDAPI_TOKEN}`);
  if (!BC_ESTADUAL()) console.error('[premium] BRASIL_CREDIT_CONSULTA_ESTADUAL não configurada — premium virá vazio.');

  // ── BrasilCredit: Base Estadual (+ sinistro/recall sob demanda) ──
  const wantSin = !!opts.sinistro && !!BC_SINISTRO();
  const wantRec = !!opts.recall   && !!BC_RECALL();
  const [wdapi, est, sin, rec] = await Promise.allSettled([
    wdapiP,
    fetchBrasilCredit(placa, BC_ESTADUAL()),
    wantSin ? fetchBrasilCredit(placa, BC_SINISTRO()) : Promise.resolve(null),
    wantRec ? fetchBrasilCredit(placa, BC_RECALL())   : Promise.resolve(null),
  ]);

  const basico   = wdapi.status === 'fulfilled' ? wdapi.value : null;
  if (est.status !== 'fulfilled') console.error('[premium] Base Estadual falhou:', est.reason?.message);
  const premium  = mapearEstadual(est.status === 'fulfilled' ? est.value : null);
  if (premium) {
    if (wantSin && sin.status === 'fulfilled' && sin.value) premium.sinistro = mapearSinistro(sin.value);
    if (wantRec && rec.status === 'fulfilled' && rec.value) premium.recall   = mapearRecall(rec.value);
  }
  return { basico, premium };
}

// ─────────────────────────────────────────────────────────────────────────────
// BRASILCREDIT — upsell de Leilão (resposta em XML)
// Requer as envs: BRASIL_CREDIT_API_BASE_URL, BRASIL_CREDIT_API_USERNAME,
// BRASIL_CREDIT_API_PASSWORD e BRASIL_CREDIT_CONSULTA_ID (id numerico da consulta,
// a confirmar com a BrasilCredit — configuravel abaixo via env).
// ─────────────────────────────────────────────────────────────────────────────
const _leilaoCache = new Map(); // pagamento_id -> resultado do leilao (em memória)

// Chamada genérica à BrasilCredit para qualquer consulta ID (leilão, base estadual,
// sinistro, recall...). Retorna a raiz <consulta> já parseada (com cabecalho/resposta).
// Credenciais e IP whitelist: ver [[brasilcredit-leilao-setup]].
async function fetchBrasilCredit(placa, consultaId) {
  const base  = process.env.BRASIL_CREDIT_API_BASE_URL;
  const login = process.env.BRASIL_CREDIT_API_USERNAME;
  const senha = process.env.BRASIL_CREDIT_API_PASSWORD;

  const url = `${base}/consulta?login=${encodeURIComponent(login)}` +
              `&senha=${encodeURIComponent(senha)}` +
              `&consulta=${encodeURIComponent(consultaId)}` +
              `&placa=${encodeURIComponent(placa)}`;

  const xml = await httpGetText(url);
  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false, trim: true, ignoreAttrs: true });
  return (parsed && parsed.consulta) || {};  // <consulta> { <cabecalho>, <resposta> }
}

async function consultarLeilao(placa) {
  const consultaId = process.env.BRASIL_CREDIT_CONSULTA_ID; // <-- ID_CONSULTA de Leilão (578)

  // Estrutura real (doc BrasilCredit): <consulta> { <cabecalho>, <resposta> }.
  const root = await fetchBrasilCredit(placa, consultaId);
  const cab  = root.cabecalho || {};

  const arr = (v) => (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]));
  const obj = (v) => (v && typeof v === 'object' ? v : {}); // <tag/> vazia vira '' -> {}

  // cabecalho.status: "0" = requisicao ok; qualquer outro (ex.: "99") = erro
  // (credencial invalida, servico fora etc.). Nesse caso nao ha <resposta>.
  const statusReq = String(cab.status ?? '').trim();
  if (statusReq !== '0') {
    return {
      erro: true,
      status: statusReq || 'sem_status',
      mensagem: String(cab.mensagem ?? cab.mensagem_status ?? 'Erro na consulta BrasilCredit').trim(),
      encontrado: false,
      leiloes: [], remarketing: [], score: {}, analise_risco: {}, checklist: {}
    };
  }

  const resp  = obj(root.resposta);
  const solic = obj(resp.solicitacao);
  const risco = obj(resp.avaliacao_risco);

  // solicitacao.mensagem: "1" = veiculo localizado na base, "0" = nao encontrado.
  const encontrado = String(solic.mensagem ?? '').trim() === '1';

  return {
    encontrado,
    descricao:            String(solic.descricao_mensagem ?? '').trim(),
    veiculo:              obj(resp.dados_veiculo),
    leiloes:              arr(obj(resp.leiloes).registro),
    remarketing:          arr(obj(resp.remarketing).registro),
    score:                obj(risco.score),                         // { score, descricao_score }
    analise_risco:        obj(risco.analise_risco),                 // { parecer, indice }
    probabilidade_seguro: obj(risco.probabilidade_seguro),          // { aceita_seguro, descricao }
    probabilidade_fipe:   obj(risco.probabilidade_fipe_parcial),    // { percentual_referencia, descricao }
    vistoria_especial:    obj(risco.probabilidade_vistoria_especial),
    inspecao:             obj(resp.inspecao_veiculo),               // { data_inspecao, link_1, garantia }
    checklist:            obj(resp.checklist),                      // { motor, frente, ..., obs }
    // fotos: campo nao documentado presente na resposta real. Estrutura interna
    // (quando preenchido) ainda a confirmar — passthrouh cru; null quando vazio.
    fotos:                (resp.fotos && typeof resp.fotos === 'object') ? resp.fotos : null,
  };
}


// "12312312312 JOAQUIM DA SILVA" -> "JOAQUIM DA SILVA" (tira o doc que precede o nome).
function limpaProprietario(s) {
  if (s == null) return null;
  return String(s).replace(/^\s*[\d.\-\/]{6,}\s+/, '').trim() || null;
}

// Normaliza valores monetários que a BrasilCredit devolve em formatos MISTOS
// (BR "2.296,51", US "1106.35", "911,12"...) para um Number.
function parseValorBR(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/[^\d.,]/g, '');
  if (!s) return null;
  const hasC = s.includes(','), hasD = s.includes('.');
  let num;
  if (hasC && hasD) {
    // o ÚLTIMO separador é o decimal; o outro é separador de milhar
    num = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')   // BR: 2.296,51
      : s.replace(/,/g, '');                       // US: 1,106.35
  } else if (hasC) {
    num = s.replace(',', '.');                      // 911,12 -> decimal
  } else if (hasD) {
    // só ponto: 2 casas depois = decimal (1106.35); 3 = milhar (1.106)
    num = s.split('.').pop().length === 2 ? s : s.replace(/\./g, '');
  } else {
    num = s;
  }
  const n = parseFloat(num);
  return Number.isFinite(n) ? n : null;
}

// Formata Number -> "R$ 1.106,35" (padrão brasileiro).
function fmtBRL(n) {
  const [int, dec] = Number(n).toFixed(2).split('.');
  return 'R$ ' + int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + dec;
}

// Débito estadual: registro { tipo, status, valor } -> "R$ x.xxx,xx" | "Sem débito".
function fmtDebitoEstadual(reg) {
  if (!reg) return 'Sem débito';
  const status = String(reg.status || '').toUpperCase();
  const tem = status.includes('EXISTE') && !status.includes('NAO') && !status.includes('NÃO');
  if (!tem) return 'Sem débito';
  const n = parseValorBR(reg.valor);
  return n && n > 0 ? fmtBRL(n) : 'Consta débito';
}

// Mapeia a Base Estadual (BrasilCredit consulta 575) para o MESMO shape do
// que o frontend espera (mesmas chaves). sinistro/recall entram à parte.
function mapearEstadual(root) {
  if (!root) return null;
  const cab = obj(root.cabecalho);
  if (String(cab.status ?? '').trim() !== '0') return null;   // erro (99) ou sem cabeçalho
  const resp  = obj(root.resposta);
  const solic = obj(resp.solicitacao);
  const encontrado = String(solic.mensagem ?? '').trim() === '1';

  // Shape vazio (mas válido) quando o veículo não está na base estadual.
  const vazio = {
    debitos: { ipva:null, multa:null, licenciamento:null, der:null, municipais:null, dpvat:null },
    leilao:  { consta:false, quantidade:'0', parecer_risco:null, registros:[] },
    sinistro:{ consta:null, msg:null }, recall:{ possui:null, itens:[] }, outras_restricoes:[]
  };
  if (!encontrado) return vazio;

  const v  = obj(resp.dados_veiculo);
  const ic = obj(resp.informacoes_complementares);
  const pr = obj(resp.dados_proprietarios);
  const at = obj(resp.doc_veiculo_atualizacao);
  const gv = obj(resp.gravame_veiculo);
  const cv = obj(resp.comunicacao_venda);

  // Débitos por tipo (DER, MUNICIPAIS, IPVA, LICENCIAMENTO ANUAL, VALOR DE MULTAS)
  const debs = arr(obj(resp.debitos_veiculo).registro);
  const porTipo = (frag) => debs.find(d => String(d.tipo || '').toUpperCase().includes(frag));
  const debitos = {
    ipva:          fmtDebitoEstadual(porTipo('IPVA')),
    multa:         fmtDebitoEstadual(porTipo('MULTA')),
    licenciamento: fmtDebitoEstadual(porTipo('LICENCIAMENTO')),
    der:           fmtDebitoEstadual(porTipo('DER')),
    municipais:    fmtDebitoEstadual(porTipo('MUNICIPA')),
    dpvat:         null,   // base estadual não separa DPVAT
  };

  // Restrições (alienação fiduciária, etc.)
  const restr = arr(obj(resp.restricoes_veiculo).registro)
    .map(r => [r.status, r.tipo].filter(x => x && String(x).trim()).join(' — '))
    .filter(Boolean);

  const docProp = String(pr.doc_proprietario || '').replace(/\D/g, '');

  return {
    // Proprietário
    proprietario:          limpaProprietario(pr.proprietario),
    cpf_cnpj_proprietario: pick(pr.doc_proprietario),
    tipo_doc_proprietario: docProp ? (docProp.length === 14 ? 'CNPJ' : 'CPF') : null,

    // Identificação
    renavam:          pick(v.renavam),
    chassi_completo:  pick(v.chassi),
    motor:            pick(v.numero_motor),
    municipio:        pick(v.municipio),
    uf:               pick(v.uf, (String(v.municipio || '').match(/-\s*([A-Z]{2})\s*$/) || [])[1]),
    marca:            pick(v.marca),
    modelo:           pick(v.modelo),
    combustivel:      pick(v.combustivel),
    cilindrada:       pick(v.cilindradas),
    especie:          pick(v.especie),
    tipo:             pick(v.tipo),
    carroceria:       pick(v.tipo_carroceria),
    tipo_montagem:    null,
    eixos:            pick(v.numero_eixos),
    pbt:              pick(v.peso_bruto_total),
    cmt:              pick(v.capacidade_maxima_tracao),
    capacidade_carga: pick(v.capacidade_carga),
    capacidade_passag: pick(v.capacidade_passageiro),
    potencia:         pick(v.potencia),
    categoria:        pick(v.categoria),
    procedencia:      pick(v.procedencia),
    tipo_remarcacao_chassi: pick(v.tipo_remarcacao),
    ultima_atualizacao: pick(at.data_licenciamento, at.data_emissao, pr.data_licenciamento),

    // Faturamento
    tipo_doc_faturado: pick(ic.tipo_doc_faturado),
    cpf_cnpj_faturado: pick(ic.cnpj_faturado, ic.cpf_faturado),
    uf_faturado:       pick(ic.uf_faturado),

    // Situação
    situacao_veiculo:       pick(v.situacao),
    ocorrencia_roubo_furto: null,   // base estadual não traz roubo/furto nacional

    // Comunicado de venda / Renajud
    comunicado_venda:  pick(cv.status),
    restricao_renajud: null,

    // Restrições cadastrais
    restricao01: restr[0] || null, restricao02: restr[1] || null,
    restricao03: restr[2] || null, restricao04: restr[3] || null,
    outras_restricoes: restr,

    // Gravame / financiamento
    gravame_status:          pick(gv.restricao_financeira),
    restricao_financeira:    pick(gv.restricao_financeira),
    restricao_nome_agente:   pick(gv.agente_financeiro),
    restricao_financiado:    pick(gv.nome_arrendatario),
    restricao_data_inclusao: pick(gv.data_inclusao),

    // Débitos (com DER e Municipais, além de IPVA/Multas/Licenciamento)
    debitos,

    // Leilão vem do bloco BrasilCredit dedicado (consulta 578), não da estadual.
    leilao: { consta: false, quantidade: '0', parecer_risco: null, registros: [] },

    // Preenchidos por mapearSinistro/mapearRecall quando o upsell é comprado.
    sinistro: { consta: null, msg: null },
    recall:   { possui: null, itens: [] },
  };
}

// Indício de Sinistro (BrasilCredit) -> { consta, msg }.
function mapearSinistro(root) {
  if (!root) return { consta: null, msg: null };
  const cab = obj(root.cabecalho);
  if (String(cab.status ?? '').trim() !== '0') return { consta: null, msg: null };
  const resp  = obj(root.resposta);
  const solic = obj(resp.solicitacao);
  if (String(solic.mensagem ?? '').trim() !== '1')
    return { consta: false, msg: 'Veículo não localizado na base de sinistro' };
  const ind = obj(resp.indicio);
  const codigo = String(ind.codigo ?? '').trim();
  const msg    = String(ind.mensagem ?? '').trim();
  // O `codigo` às vezes vem VAZIO na resposta real — então também olho o prefixo
  // da mensagem ("1-EXISTE..." = tem / "0-NENHUM..." = não tem). Evita falso negativo.
  const consta = codigo === '1'
    || /^\s*1\s*[-–]/.test(msg)
    || (/EXISTE\s+SINISTRO/i.test(msg) && !/NENHUM|N[AÃ]O/i.test(msg));
  return { consta, msg: pick(msg) };
}

// Recall (BrasilCredit) -> { possui, itens[] }.
function mapearRecall(root) {
  if (!root) return { possui: null, itens: [] };
  const cab = obj(root.cabecalho);
  if (String(cab.status ?? '').trim() !== '0') return { possui: null, itens: [] };
  const resp = obj(root.resposta);
  const registros = arr(obj(resp.recall).registro);
  const possui = registros.some(r => String(r.existe_recall ?? '').toUpperCase() === 'SIM') || registros.length > 0;
  const itens = registros.map(r => ({
    descricao: pick(r.identificador, r.descricao),
    situacao:  r.pendente ? ('Pendente: ' + r.pendente) : pick(r.existe_recall),
    data:      pick(r.data_registro),
    montadora: pick(r.montadora),
    modelo:    pick(r.marca_modelo),
  }));
  return { possui, itens };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────────────────────────────────────

// Índice em memória p/ recuperação de consulta paga (chave: "PLACA|email").
// ⚠️ Volátil: zera a cada restart/deploy. Para persistir de verdade, usar um DB.
const _consultasPorChave = new Map();
const _leilaoPorChave = new Map(); // "PLACA|email" -> leilão BrasilCredit (p/ /recuperar)
function chaveConsulta(placa, email) {
  return String(placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '') +
         '|' + String(email || '').trim().toLowerCase();
}
// E-mail do CLIENTE p/ a chave do "Já paguei": prioriza o metadata (o que ele
// digitou), pois no PIX o Mercado Pago sobrescreve payer.email com o de quem pagou.
function emailCliente(pag) {
  return (pag && pag.metadata && pag.metadata.email) ||
         (pag && pag.payer && pag.payer.email) || null;
}

// Formata a resposta "completa" (wdapi2 básico + premium já mapeado + leilão BrasilCredit).
// `premium` = saída de montarConsultaPremium (mapearEstadual).
// Usado pela rota /completa e pela /recuperar. `leilao` é opcional (só quem comprou o upsell).
function formatarCompleta(d, premium, placa, leilao) {
  d = d || {};
  return {
    marca:            d.MARCA        || null,
    modelo:           d.MODELO       || null,
    submodelo:        d.SUBMODELO    || null,
    versao:           d.VERSAO       || null,
    ano_fab:          d.ano          || null,
    ano_modelo:       d.anoModelo    || null,
    chassi:           d.chassi       || null,
    cor:              d.cor          || null,
    origem:           d.origem       || null,
    placa:            d.placa        || placa || null,
    situacao:         d.situacao     || null,
    municipio:        d.municipio    || null,
    uf:               d.uf           || null,
    logo:             d.logo         || null,
    combustivel:      d.extra?.combustivel      || null,
    cilindradas:      d.extra?.cilindradas      || null,
    especie:          d.extra?.especie          || null,
    tipo_veiculo:     d.extra?.tipo_veiculo     || null,
    tipo_carroceria:  d.extra?.tipo_carroceria  || null,
    segmento:         d.extra?.segmento         || null,
    sub_segmento:     d.extra?.sub_segmento     || null,
    quantidade_passageiro: d.extra?.quantidade_passageiro || null,
    peso_bruto_total: d.extra?.peso_bruto_total || null,
    nacionalidade:    d.extra?.nacionalidade    || null,
    fipe:             melhorFipe(d),
    premium:          premium || null,
    leilao:           leilao || null   // relatório BrasilCredit (upsell); null se não comprado
  };
}

// Lê os upsells comprados do metadata do pagamento (gravado no criarPagamento).
// Retorna { upsells: string[] | null, combo: bool }.
//  - upsells === null  => metadata SEM a chave `upsells` = pagamento legado (antes da
//    blindagem) ou fluxo sem metadata => o chamador deve liberar tudo.
//  - upsells === []    => compra nova só da base (metadata.upsells === 'nenhum') => blinda tudo.
function lerUpsellsMeta(metadata) {
  const combo = !!(metadata && (metadata.combo === '1' || metadata.combo === true));
  const raw = metadata ? metadata.upsells : undefined;
  if (raw == null) return { upsells: null, combo };   // legado / sem info => libera tudo
  const upsells = String(raw).split(',').map(s => s.trim().toLowerCase())
    .filter(s => s && s !== 'nenhum');
  return { upsells, combo };
}

// Blindagem: remove do payload /completa os campos de upsell que o cliente NÃO comprou.
// `dados` é a saída de formatarCompleta (objeto fresco a cada request — seguro mutar).
//  - combo === true            => retorna tudo.
//  - upsells === null          => legado/recuperar => retorna tudo (não quebra fluxos antigos).
//  - upsells === [] ou lista   => nula os campos ausentes (base-only blinda os 4).
function blindarPorUpsells(dados, upsells, combo) {
  if (combo || upsells == null) return dados;   // libera tudo
  const tem = k => upsells.includes(k);
  const p = dados && dados.premium;
  if (p) {
    if (!tem('debitos') && p.debitos)
      p.debitos = { ipva: null, multa: null, licenciamento: null, dpvat: null, der: null, municipais: null };
    if (!tem('sinistro') && p.sinistro)
      p.sinistro = { consta: null, msg: null };
    if (!tem('recall') && p.recall)
      p.recall = { possui: null, itens: [] };
    if (!tem('leilao') && p.leilao)
      p.leilao = { consta: null, quantidade: null, parecer_risco: null, registros: [] };
  }
  if (dados && !tem('leilao')) dados.leilao = null;   // bloco BrasilCredit
  return dados;
}

// ── Proteção da consulta GRÁTIS (protege o saldo da wdapi2) ──
// 1) Cache curto por placa: repetir a mesma placa não gasta wdapi2 de novo.
// 2) Limite por IP (janela fixa): trava spam de placas diferentes. Só conta no
//    cache MISS (chamada real). Tudo configurável por env.
const _basicaCache = new Map();  // placa -> { data, exp }
const _rlBasica    = new Map();  // ip -> { count, resetAt }
const BASICA_TTL_MS  = Number(process.env.BASICA_CACHE_MS   || 15 * 60 * 1000); // 15 min
const RL_MAX         = Number(process.env.RATE_LIMIT_MAX    || 15);             // consultas/janela
const RL_WINDOW_MS   = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000); // 10 min

// Consume 1 do limite do IP. Retorna null se ok, ou os segundos p/ tentar de novo.
function consumirRate(ip) {
  const now = Date.now();
  let e = _rlBasica.get(ip);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + RL_WINDOW_MS }; _rlBasica.set(ip, e); }
  if (e.count >= RL_MAX) return Math.ceil((e.resetAt - now) / 1000);
  e.count++;
  return null;
}
// Limpeza periódica das janelas expiradas (evita crescimento infinito do Map).
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _rlBasica) if (now >= e.resetAt) _rlBasica.delete(ip);
  for (const [placa, c] of _basicaCache) if (now >= c.exp) _basicaCache.delete(placa);
}, 5 * 60 * 1000).unref();

// Consulta básica — wdapi2 (gratuita, antes do pagamento)
app.get('/api/consulta/basica/:placa', async (req, res) => {
  const placa = req.params.placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!placaValida(placa))
    return res.status(400).json({ erro: 'Formato de placa inválido.' });

  // 1) Cache por placa — não gasta wdapi2 nem consome o limite do IP.
  const cached = _basicaCache.get(placa);
  if (cached && Date.now() < cached.exp) return res.json(cached.data);

  // 2) Limite por IP — só nas chamadas reais (cache miss).
  const retry = consumirRate(req.ip || 'unknown');
  if (retry != null) {
    res.set('Retry-After', String(retry));
    return res.status(429).json({
      erro: 'Você fez muitas consultas em pouco tempo. Aguarde alguns minutos e tente novamente.',
      retry_after_s: retry
    });
  }

  try {
    const d = await httpGet(
      `https://wdapi2.com.br/consulta/${placa}/${process.env.WDAPI_TOKEN}`
    );

    const payload = {
      marca:            d.MARCA        || null,
      modelo:           d.MODELO       || null,
      submodelo:        d.SUBMODELO    || null,
      versao:           d.VERSAO       || null,
      marcaModelo:      d.marcaModelo  || null,
      ano_fab:          d.ano          || null,
      ano_modelo:       d.anoModelo    || null,
      chassi:           d.chassi       || null,
      cor:              d.cor          || null,
      origem:           d.origem       || null,
      placa:            d.placa        || placa,
      placa_alternativa: d.placa_alternativa || null,
      situacao:         d.situacao     || null,
      codigoSituacao:   d.codigoSituacao || null,
      municipio:        d.municipio    || null,
      uf:               d.uf           || null,
      logo:             d.logo         || null,
      combustivel:      d.extra?.combustivel         || null,
      cilindradas:      d.extra?.cilindradas         || null,
      especie:          d.extra?.especie             || null,
      tipo_veiculo:     d.extra?.tipo_veiculo        || null,
      tipo_carroceria:  d.extra?.tipo_carroceria     || null,
      tipo_montagem:    d.extra?.tipo_montagem       || null,
      eixos:            d.extra?.eixos               || null,
      quantidade_passageiro: d.extra?.quantidade_passageiro || null,
      peso_bruto_total: d.extra?.peso_bruto_total    || null,
      cap_maxima_tracao:d.extra?.cap_maxima_tracao   || null,
      nacionalidade:    d.extra?.nacionalidade       || null,
      segmento:         d.extra?.segmento            || null,
      sub_segmento:     d.extra?.sub_segmento        || null,
      situacao_chassi:  d.extra?.situacao_chassi     || null,
      situacao_veiculo: d.extra?.situacao_veiculo    || null,
      tipo_doc_prop:    d.extra?.tipo_doc_prop       || null,
      uf_placa:         d.extra?.uf_placa            || null,
      placa_modelo_novo:  d.extra?.placa_modelo_novo  || null,
      placa_modelo_antigo: d.extra?.placa_modelo_antigo || null,
      fipe: melhorFipe(d)
    };

    _basicaCache.set(placa, { data: payload, exp: Date.now() + BASICA_TTL_MS });
    res.json(payload);
  } catch (err) {
    console.error('[basica]', err.message);
    res.status(500).json({ erro: 'Erro ao consultar. Tente novamente.' });
  }
});

// Proxy logo (evita CORS)
app.get('/api/logo', (req, res) => {
  const { url } = req.query;
  if (!url?.startsWith('https://apiplacas.com.br/'))
    return res.status(400).end();
  https.get(url, (logoRes) => {
    res.setHeader('Content-Type', logoRes.headers['content-type'] || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    logoRes.pipe(res);
  }).on('error', () => res.status(404).end());
});

// Criar pagamento PIX
app.post('/api/pagamento/criar', async (req, res) => {
  const { plano, placa, email, nome, cpf, extras, upsells, combo } = req.body;

  // ─── Preços: fonte da verdade no SERVIDOR (devem espelhar o Checkout.dc.html) ───
  // SEGURANÇA: nunca confiar no `valor` enviado pelo frontend — o total é sempre
  // recomputado aqui a partir dos upsells/combo. O `valor` do cliente só é comparado
  // para log de divergência.
  const CHECKOUT_BASE = 14.99;                                              // relatório base
  const UPSELL_PRECO  = { sinistro: 9.99, leilao: 9.99, debitos: 4.90, recall: 3.90 };
  const COMBO_TOTAL   = 32.90;                                              // base + 4 upsells c/ desconto

  // Normaliza a lista de upsells comprados (aceita `upsells`; cai p/ o legado `extras`).
  const brutos = Array.isArray(upsells) ? upsells : (Array.isArray(extras) ? extras : []);
  const setUpsells = [...new Set(
    brutos.map(x => String(x).toLowerCase().trim())
          .filter(k => Object.prototype.hasOwnProperty.call(UPSELL_PRECO, k))
  )];
  const comboAtivo   = combo === true || combo === '1' || setUpsells.length === 4;
  const upsellsFinal = comboAtivo ? Object.keys(UPSELL_PRECO) : setUpsells; // combo = leva os 4
  const querLeilao   = upsellsFinal.includes('leilao');                     // dispara BrasilCredit

  const planosFixos = {
    basico:  { valor: 19.90, descricao: 'Consulta Veicular Básica'  },
    simples: { valor: 29.90, descricao: 'Consulta Veicular Simples' }
  };

  // Calcula o valor autoritativo a cobrar.
  let valorCobrar, descricao;
  if (plano === 'completo') {
    valorCobrar = comboAtivo
      ? COMBO_TOTAL
      : +(CHECKOUT_BASE + upsellsFinal.reduce((s, k) => s + UPSELL_PRECO[k], 0)).toFixed(2);
    descricao = comboAtivo ? 'Consulta Veicular Completa (Combo)' : 'Consulta Veicular Completa';
  } else if (planosFixos[plano]) {
    valorCobrar = planosFixos[plano].valor;
    descricao   = planosFixos[plano].descricao;
  } else {
    return res.status(400).json({ erro: 'Plano inválido.' });
  }

  // Sanidade: compara com o valor que o frontend calculou (só loga se divergir).
  const valorCliente = Number(req.body.valor);
  if (!Number.isNaN(valorCliente) && Math.abs(valorCliente - valorCobrar) > 0.01) {
    console.warn(`[criar] valor divergente — frontend=${valorCliente} servidor=${valorCobrar} (cobrando o do servidor)`);
  }
  if (!(valorCobrar > 0)) return res.status(400).json({ erro: 'Valor inválido.' });

  // ── MODO TESTE (produção): e-mail específico paga valor simbólico. ──
  // Ative com as envs TEST_EMAIL (seu e-mail) e opcional TEST_PRICE (padrão 0.01).
  // Os upsells/combo do metadata continuam REAIS → o relatório sai idêntico ao de
  // produção; só o valor do PIX muda. Clientes com outro e-mail pagam normal.
  // REMOVER a env TEST_EMAIL após testar.
  if (process.env.TEST_EMAIL &&
      String(email || '').trim().toLowerCase() === process.env.TEST_EMAIL.trim().toLowerCase()) {
    const testPrice = Number(process.env.TEST_PRICE || 0.01);
    console.warn(`[criar] MODO TESTE p/ ${email}: cobrando R$${testPrice} (real seria R$${valorCobrar})`);
    valorCobrar = testPrice;
  }

  try {
    const idempotencyKey = `${placa}-${plano}-${Date.now()}`;
    const pagamento = await httpPost(
      'https://api.mercadopago.com/v1/payments',
      {
        transaction_amount: valorCobrar,
        description: `${descricao} — Placa ${placa}`,
        payment_method_id: 'pix',
        payer: {
          email: email || 'cliente@sosbuscasonline.com.br',
          first_name: nome?.split(' ')[0] || 'Cliente',
          last_name:  nome?.split(' ').slice(1).join(' ') || 'SOS',
          identification: { type: 'CPF', number: cpf?.replace(/\D/g,'') || '00000000000' }
        },
        metadata: {
          placa, plano,
          leilao:  querLeilao ? '1' : '0',           // gate da BrasilCredit no pós-pagamento
          upsells: upsellsFinal.join(',') || 'nenhum', // upsells comprados (p/ liberar seções)
          combo:   comboAtivo ? '1' : '0',
          // E-mail que o CLIENTE digitou — chave do "Já paguei". Guardamos aqui porque
          // no PIX o Mercado Pago sobrescreve payer.email com o e-mail de quem pagou.
          email:   String(email || '').trim().toLowerCase()
        }
      },
      {
        'Authorization':    `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'X-Idempotency-Key': idempotencyKey
      }
    );

    if (pagamento.error) {
      console.error('[MP ERRO]', JSON.stringify(pagamento));
      throw new Error(pagamento.message || pagamento.error);
    }

    res.json({
      id:             pagamento.id,
      status:         pagamento.status,
      qr_code:        pagamento.point_of_interaction?.transaction_data?.qr_code        || null,
      qr_code_base64: pagamento.point_of_interaction?.transaction_data?.qr_code_base64 || null,
      valor:          valorCobrar,
      descricao:      descricao
    });
  } catch (err) {
    console.error('[criar pagamento]', err.message);
    res.status(500).json({ erro: err.message || 'Erro ao criar pagamento.' });
  }
});

// Status do pagamento — quando aprovado, dispara a consulta premium,
// guarda o resultado em memória (chave = pagamento_id) e o devolve junto.
app.get('/api/pagamento/status/:id', async (req, res) => {
  try {
    const d = await mpGet(`/v1/payments/${req.params.id}`);
    const out = { id: d.id, status: d.status, plano: d.metadata?.plano, placa: d.metadata?.placa };

    if (d.status === 'approved' && d.metadata?.placa) {
      const id = String(d.id);
      const placa = d.metadata.placa.toUpperCase().replace(/[^A-Z0-9]/g, '');

      // Upsells comprados => decide quais consultas BrasilCredit disparar (sinistro/recall).
      const { upsells, combo } = lerUpsellsMeta(d.metadata);
      const has = k => combo || (Array.isArray(upsells) && upsells.includes(k));
      const optsP = { sinistro: has('sinistro'), recall: has('recall') };

      // Premium dispara em BACKGROUND (não bloqueia a resposta do status).
      // BLINDAGEM: NÃO devolvemos o conteúdo premium aqui — só um flag de "pronto".
      // O relatório real (já blindado por upsell) é buscado depois via /completa.
      // Assim os dados não vazam pela rota de status. O objeto completo continua
      // guardado em memória (_consultasPorChave) para a /recuperar.
      const emailCli = emailCliente(d);
      const premium = bgCache(_premiumCache, _premiumPending, id, () => montarConsultaPremium(placa, optsP));
      if (premium && emailCli) {
        _consultasPorChave.set(chaveConsulta(placa, emailCli), premium); // indexa p/ /recuperar
      }
      out.premium = premium ? true : null;   // flag de prontidão (não o conteúdo)

      // Upsell de Leilão (BrasilCredit) — também em background, só se foi comprado
      if (d.metadata?.leilao === '1') {
        const leilao = bgCache(_leilaoCache, _leilaoPending, id, () => consultarLeilao(placa));
        if (leilao && emailCli) _leilaoPorChave.set(chaveConsulta(placa, emailCli), leilao);
        out.leilao = leilao ? true : null;   // flag (conteúdo vem só na /completa)
      }
    }

    res.json(out);
  } catch (err) {
    console.error('[status]', err.message);
    res.status(500).json({ erro: 'Erro ao verificar pagamento.' });
  }
});

// Consulta premium (BrasilCredit + wdapi2) — só após pagamento aprovado.
// Segurança: exige pagamento_id não vazio E confirma no Mercado Pago que o
// pagamento está 'approved' e que a placa corresponde ao pagamento.
app.post('/api/consulta/premium', async (req, res) => {
  const { placa, pagamento_id } = req.body || {};

  if (!pagamento_id) return res.status(403).json({ erro: 'pagamento_id obrigatório.' });
  if (!placa || !placaValida(placa))
    return res.status(400).json({ erro: 'Formato de placa inválido.' });

  const placaU = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');

  try {
    // Verificação real: o pagamento existe, está aprovado e é desta placa?
    const pag = await mpGet(`/v1/payments/${pagamento_id}`);
    if (pag.status !== 'approved')
      return res.status(402).json({ erro: 'Pagamento não confirmado.' });
    if (pag.metadata?.placa && pag.metadata.placa.toUpperCase() !== placaU)
      return res.status(403).json({ erro: 'Placa não corresponde ao pagamento.' });

    const resultado = await montarConsultaPremium(placaU);
    _premiumCache.set(String(pagamento_id), resultado);
    { const ec = emailCliente(pag); if (ec) _consultasPorChave.set(chaveConsulta(placaU, ec), resultado); }
    res.json(resultado);
  } catch (err) {
    console.error('[premium]', err.message);
    res.status(500).json({ erro: 'Erro ao consultar.' });
  }
});

// Consulta completa pós-pagamento — wdapi2 + BrasilCredit
app.get('/api/consulta/completa/:placa/:pagamento_id', async (req, res) => {
  const { placa, pagamento_id } = req.params;

  try {
    // 1. Confirma pagamento aprovado
    const pag = await mpGet(`/v1/payments/${pagamento_id}`);
    if (pag.status !== 'approved')
      return res.status(402).json({ erro: 'Pagamento não confirmado.' });
    if (pag.metadata?.placa?.toUpperCase() !== placa.toUpperCase())
      return res.status(403).json({ erro: 'Placa não corresponde ao pagamento.' });

    // 2. Upsells comprados (metadata gravado no criarPagamento) — controla a blindagem
    //    e quais consultas BrasilCredit disparar (sinistro/recall).
    const { upsells, combo } = lerUpsellsMeta(pag.metadata);
    const has = k => combo || (Array.isArray(upsells) && upsells.includes(k));

    // 3. Reaproveita o resultado já disparado no pós-pagamento (evita reconsultar).
    //    Se ainda estiver processando, espera a MESMA promise.
    const key = String(pagamento_id);
    let resultado = _premiumCache.get(key);
    if (!resultado && _premiumPending.get(key)) resultado = await _premiumPending.get(key);
    if (!resultado) {
      resultado = await montarConsultaPremium(placa, { sinistro: has('sinistro'), recall: has('recall') });
      _premiumCache.set(key, resultado);
    }

    // 4. Leilão (BrasilCredit) — só se o upsell foi comprado (metadata.leilao === '1').
    //    Reaproveita o cache do pós-pagamento; senão consulta e cacheia.
    let leilao = null;
    if (pag.metadata?.leilao === '1') {
      leilao = _leilaoCache.get(key);
      if (!leilao && _leilaoPending.get(key)) leilao = await _leilaoPending.get(key);
      if (!leilao) { leilao = await consultarLeilao(placa); _leilaoCache.set(key, leilao); }
    }

    // 5. Formata e BLINDA — omite os campos dos upsells não comprados antes de enviar.
    const dados = blindarPorUpsells(formatarCompleta(resultado.basico, resultado.premium, placa, leilao), upsells, combo);

    // 6. Persiste p/ o "Já paguei" (durável, sobrevive a deploys). Fire-and-forget.
    const placaU = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const emailCli = emailCliente(pag);
    if (emailCli) {
      const chave = chaveConsulta(placaU, emailCli);
      _consultasPorChave.set(chave, resultado);        // cache em memória (mesma instância)
      dbSalvar(chave, placaU, emailCli, key, dados);   // persistência no banco
    }

    res.json(dados);

  } catch (err) {
    console.error('[completa]', err.message);
    res.status(500).json({ erro: 'Erro ao consultar.' });
  }
});

// Recuperar consulta já paga — pelo par placa + email ("Já paguei")
app.get('/api/consulta/recuperar', async (req, res) => {
  const { placa, email } = req.query;

  // 1. Validar parâmetros
  if (!placa || !email) {
    return res.status(400).json({ found: false, msg: 'Placa e e-mail obrigatórios.' });
  }

  const placaU = String(placa).toUpperCase().replace(/[^A-Z0-9]/g, '');

  try {
    const chave = chaveConsulta(placaU, email);

    // 2. Banco (durável) — relatório já pronto, sobrevive a deploys/reinícios.
    const salvo = await dbBuscar(chave);
    if (salvo) return res.json({ found: true, dados: salvo });

    // 3. Fallback: índice em memória (mesma instância) — legado/sem banco.
    let resultado = _consultasPorChave.get(chave);
    if (!resultado) {
      return res.json({ found: false });
    }

    // 4. Tem o pagamento, mas sem os dados premium → gera agora.
    if (!resultado.premium) {
      try {
        resultado = await montarConsultaPremium(placaU);
        _consultasPorChave.set(chave, resultado);
      } catch (e) {
        console.error('[recuperar] regerar premium:', e.message);
      }
    }

    // 5. Formata (mesmo formato da /completa) e persiste p/ as próximas vezes.
    const leilao = _leilaoPorChave.get(chave) || null;
    const dados = formatarCompleta(resultado.basico, resultado.premium, placaU, leilao);
    dbSalvar(chave, placaU, email, null, dados);
    return res.json({ found: true, dados });

  } catch (err) {
    console.error('[recuperar]', err.message);
    return res.status(500).json({ found: false, msg: 'Erro ao buscar consulta.' });
  }
});

// Consulta de Leilão (BrasilCredit) — upsell, só após pagamento aprovado.
app.post('/api/consulta/leilao', async (req, res) => {
  const { placa, pagamento_id } = req.body || {};

  if (!pagamento_id) return res.status(403).json({ erro: true, msg: 'pagamento_id obrigatório.' });
  if (!placa || !placaValida(placa))
    return res.status(400).json({ erro: true, msg: 'Formato de placa inválido.' });

  const placaU = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');

  try {
    // Mesmo padrão da /completa: confirma pagamento aprovado e placa correspondente.
    const pag = await mpGet(`/v1/payments/${pagamento_id}`);
    if (pag.status !== 'approved')
      return res.status(402).json({ erro: true, msg: 'Pagamento não confirmado.' });
    if (pag.metadata?.placa && pag.metadata.placa.toUpperCase() !== placaU)
      return res.status(403).json({ erro: true, msg: 'Placa não corresponde ao pagamento.' });

    const dados = await consultarLeilao(placaU);
    _leilaoCache.set(String(pagamento_id), dados);
    res.json(dados); // { encontrado, leiloes, remarketing, score, analise_risco, checklist }
  } catch (err) {
    console.error('[leilao]', err.message);
    res.status(500).json({ erro: true, msg: 'Erro ao consultar leilão.' });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
