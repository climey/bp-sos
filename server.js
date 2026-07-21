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

// ─────────────────────────────────────────────────────────────────────────────
// FUTUREDATA AUTH
// Cache do token para não autenticar a cada requisição
// ─────────────────────────────────────────────────────────────────────────────
let _fdToken = null;
let _fdTokenExpires = 0;

async function getFutureDataToken() {
  const now = Date.now();

  // Token válido em cache — evita chamar /auth a cada consulta
  if (_fdToken && now < _fdTokenExpires) return _fdToken;

  // A FutureData espera os campos `email` e `pass` (conforme doc /auth).
  let res;
  try {
    res = await httpPost(process.env.FUTURE_DATA_API_AUTH_URL, {
      email: process.env.FUTURE_DATA_API_USERNAME,
      pass:  process.env.FUTURE_DATA_API_PASSWORD
    });
  } catch (e) {
    console.error('[FutureData] auth request error:', e.message);
    throw new Error('FutureData auth failed');
  }

  const token = res && (res.token || res.access_token);
  if (!token) {
    console.error('[FutureData] auth sem token — resposta:',
      JSON.stringify({ success: res && res.success, message: res && res.message }));
    throw new Error('FutureData auth failed');
  }

  _fdToken = token;
  _fdTokenExpires = now + 30 * 60 * 1000; // cache de 30 minutos
  console.log('[FutureData] Token renovado');
  return _fdToken;
}

async function consultarFutureData(placa) {
  const token = await getFutureDataToken();

  const res = await httpPost(
    `${process.env.FUTURE_DATA_API_BASE_URL}/veicular-completa`,
    { placa },
    { 'x-access-token': token }
  );

  if (!res.success) {
    throw new Error(res.msg || 'Erro na consulta FutureData');
  }

  return res.dados;
}

// ─────────────────────────────────────────────────────────────────────────────
// VIP CAR (DespBrasil) — provedor premium alternativo
// Dormente por enquanto: função pronta, mas ainda NÃO ligada no fluxo.
// Requer a env VIPCAR_API_KEY. Custo: R$ 21/consulta (debita saldo da conta).
// ─────────────────────────────────────────────────────────────────────────────
async function consultarVipCar(placa) {
  // Endpoint/formato corretos (via suporte DespBrasil): app id 6994...,
  // chave no header `chaveAcesso`, body só { servico, placa }.
  const res = await httpPost(
    'https://api.base44.app/api/apps/6994c2ecf6eea3bac6164bbf/functions/apiConsulta',
    { servico: 'vipcar', placa },
    { 'chaveAcesso': process.env.VIPCAR_API_KEY }
  );
  if (!res || res.sucesso !== true) {
    throw new Error((res && (res.message || res.erro || res.mensagem)) || 'Erro na consulta VIP CAR');
  }
  return res.dados;
}

// Monta a consulta premium unificada (wdapi2 básico + FutureData), usada tanto
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

async function montarConsultaPremium(placa) {
  const [wdapi, futuredata] = await Promise.allSettled([
    httpGet(`https://wdapi2.com.br/consulta/${placa}/${process.env.WDAPI_TOKEN}`),
    consultarFutureData(placa)
  ]);

  const basico = wdapi.status === 'fulfilled' ? wdapi.value : null;

  if (futuredata.status === 'fulfilled') {
    return { futuredata: futuredata.value, basico };
  }
  console.error('[premium] FutureData falhou:', futuredata.reason?.message);
  return { futuredata: null, futuredata_error: true, basico };
}

// ─────────────────────────────────────────────────────────────────────────────
// BRASILCREDIT — upsell de Leilão (resposta em XML)
// Requer as envs: BRASIL_CREDIT_API_BASE_URL, BRASIL_CREDIT_API_USERNAME,
// BRASIL_CREDIT_API_PASSWORD e BRASIL_CREDIT_CONSULTA_ID (id numerico da consulta,
// a confirmar com a BrasilCredit — configuravel abaixo via env).
// ─────────────────────────────────────────────────────────────────────────────
const _leilaoCache = new Map(); // pagamento_id -> resultado do leilao (em memória)

async function consultarLeilao(placa) {
  const base       = process.env.BRASIL_CREDIT_API_BASE_URL;
  const login      = process.env.BRASIL_CREDIT_API_USERNAME;
  const senha      = process.env.BRASIL_CREDIT_API_PASSWORD;
  const consultaId = process.env.BRASIL_CREDIT_CONSULTA_ID; // <-- ID_CONSULTA configuravel

  const url = `${base}/consulta?login=${encodeURIComponent(login)}` +
              `&senha=${encodeURIComponent(senha)}` +
              `&consulta=${encodeURIComponent(consultaId)}` +
              `&placa=${encodeURIComponent(placa)}`;

  const xml = await httpGetText(url);
  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false, trim: true, ignoreAttrs: true });

  // A raiz costuma ser um unico elemento envolvendo a resposta.
  const root = parsed && typeof parsed === 'object' ? (Object.values(parsed)[0] || {}) : {};

  // <mensagem>1</mensagem> = veiculo encontrado
  const mensagem = String(root.mensagem ?? root.Mensagem ?? '').trim();
  const encontrado = mensagem === '1';

  const arr = (v) => (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]));

  return {
    encontrado,
    leiloes:       arr(root.leiloes ?? root.leilao ?? root.Leiloes),
    remarketing:   arr(root.remarketing ?? root.Remarketing),
    score:         root.score ?? root.Score ?? {},
    analise_risco: root.avaliacao_risco ?? root.analise_risco ?? root.parecer ?? {},
    checklist:     root.checklist ?? root.Checklist ?? {},
    // _raw: temporario, ajuda a mapear os campos reais do XML; remover apos ajuste.
    _raw: root
  };
}

// Formata débito -> "Sem débito" ou "R$ valor"
function fmtDebito(existe, valor) {
  const e = String(existe || '').toUpperCase();
  if (!e || e.includes('NAO EXISTE') || e.includes('NÃO EXISTE')) return 'Sem débito';
  const v = String(valor || '').trim();
  return v && v !== '0,00' && v !== '0.00' ? ('R$ ' + v) : 'Consta débito';
}

// Mapeia a resposta da Veicular Completa (estrutura aninhada) num objeto padronizado.
// Também aceita a resposta antiga (plana) por retrocompatibilidade.
function mapearFutureData(dados) {
  if (!dados) return null;
  // Se vier no formato antigo (plano, sem sub-objetos), embrulha em "nacional".
  const flat = !dados.nacional && !dados.estadual && (dados.renavam || dados.chassi);
  const e  = dados.estadual || {};
  const n  = dados.nacional || (flat ? dados : {});
  const rf = dados['roubo-furto'] || {};
  const g  = dados.gravame || {};
  const rj = dados.renajud || {};
  const lo = (dados.leilao && dados.leilao.leilao) || {};
  const lr = (dados.leilao && dados.leilao.analise_risco) || {};
  const si = dados['indicio-sinistro'] || {};
  const rc = dados.recall || {};
  const pa = dados['proprietario-atual'] || {};

  const pick = (...vals) => {
    for (const v of vals) { if (v != null && String(v).trim() !== '') return v; }
    return null;
  };

  const outras = [
    n.outras_restricoes_01, n.outras_restricoes_02, n.outras_restricoes_03, n.outras_restricoes_04,
    n.outras_restricoes_05, n.outras_restricoes_06, n.outras_restricoes_07, n.outras_restricoes_08,
    e.outras_restricoes_01, e.outras_restricoes_02, e.outras_restricoes_03, e.outras_restricoes_04
  ].filter(r => r && String(r).trim().toUpperCase() !== 'NADA CONSTA');

  return {
    // Proprietário
    proprietario:          pick(pa.nome, e.pronomeanterior, n.nome_proprietario),
    cpf_cnpj_proprietario: pick(pa.documento, n.cpf_cnpj_proprietario, e.cpf_cnpj_proprietario),
    tipo_doc_proprietario: pick(n.tipodocproprietario, e.tipodocumentoproprietario),

    // Identificação
    renavam:          pick(n.renavam, e.renavam, pa.renavam, rf.renavam),
    chassi_completo:  pick(n.chassi, e.chassi, pa.chassi, rf.chassi),
    motor:            pick(n.motor, e.motor, rf.motor, pa.motor),
    municipio:        pick(n.municipio, e.municipio, pa.municipio),
    uf:               pick(n.uf, e.uf, pa.uf),
    marca:            pick(n.marca, e.marca),
    modelo:           pick(n.modelo, e.modelo),
    combustivel:      pick(n.combustivel, e.combustivel),
    cilindrada:       pick(n.cilindrada, e.cilindrada),
    especie:          pick(n.especie, e.especie),
    tipo:             pick(n.tipo, e.tipo, pa.tipo),
    carroceria:       pick(n.carroceria, e.carroceria, pa.carroceria),
    tipo_montagem:    pick(n.tipomontagem, rf.montagem),
    eixos:            pick(n.eixos, e.eixos, rf.num_eixo),
    pbt:              pick(n.pbt, e.pbt),
    cmt:              pick(n.cmt, e.cmt),
    capacidade_carga: pick(n.capacidadecarga, e.capacidadecarga, pa.capacidade_carga),
    capacidade_passag: pick(n.capacidadepassag, e.capacidadepassag),
    potencia:         pick(n.potencia, e.potencia, pa.potencia),
    categoria:        pick(n.categoria, e.veicategoria),
    procedencia:      pick(n.veiprocedencia, e.veiprocedencia, pa.procedencia),
    tipo_remarcacao_chassi: pick(n.tiporemarcchassi, e.tiporemarcacaochassi, rf.remarcacao_do_chassi),
    ultima_atualizacao: pick(n.ultimaatualizacao, rf.ultima_atualizacao),

    // Faturamento
    tipo_doc_faturado: pick(n.tipodocumentofaturado, e.tipodocumentofaturado),
    cpf_cnpj_faturado: pick(n.cpfcnpjfaturado, e.cpfcnpjfaturado),
    uf_faturado:       pick(n.uffaturado, e.uffaturado),

    // Situação
    situacao_veiculo:       pick(n.situacaoveic, e.situacaoveiculo, rf.situacao),
    ocorrencia_roubo_furto: pick(rf.ocorrencia, n.ocorrencia),

    // Comunicado de venda / Renajud
    comunicado_venda:  pick(n.indicadorcomunicacaodevendas, e.ccomunicacaovenda),
    restricao_renajud: pick(rj.msg, e.resrenajud, n.indicadorrestricaorenajud),

    // Restrições cadastrais
    restricao01: n.restricao01 || null, restricao02: n.restricao02 || null,
    restricao03: n.restricao03 || null, restricao04: n.restricao04 || null,
    outras_restricoes: outras,

    // Gravame / financiamento
    gravame_status:          pick(g.descricaostatus, e.restricaofinan),
    restricao_financeira:    pick(g.financeiranome, n.restricoesrestricaofinan, e.restricaofinan),
    restricao_nome_agente:   pick(g.financeiranome, e.restricaonomeagente),
    restricao_financiado:    pick(g.nomefinanciado, e.restricaoarrendatario),
    restricao_data_inclusao: pick(g.datagravame, e.restricaodatainclusao),

    // Débitos (estadual) — já formatados para exibição
    debitos: {
      ipva:          fmtDebito(e.existedebitodeipva, e.debipva),
      multa:         fmtDebito(e.existedebitomulta, e.valortotaldebitomulta),
      licenciamento: fmtDebito(e.existedebitodelicenciamento, e.existedebitodelicenciamentovl),
      dpvat:         fmtDebito(e.existedebitodedpvat, e.dpvat),
    },

    // Leilão
    leilao: {
      consta: (lo.qtdleilao && Number(lo.qtdleilao) > 0) || (Array.isArray(lo.registro) && lo.registro.length > 0) || false,
      quantidade: lo.qtdleilao || (Array.isArray(lo.registro) ? String(lo.registro.length) : '0'),
      parecer_risco: pick(lr.parecer, lr.descricaoretorno),
      registros: (Array.isArray(lo.registro) ? lo.registro : []).map(r => ({
        data: r.dataleilao || null, lote: r.lote || null,
        comitente: r.comitente || null, patio: r.patio || null
      })),
    },

    // Indício de sinistro
    sinistro: { consta: !!si.consta_indicio_sinistro, msg: si.msg || null },

    // Recall
    recall: {
      possui: !!rc.possui_recall,
      itens: (Array.isArray(rc.recalls) ? rc.recalls : []).map(r => ({
        descricao: r.descricao || r.identificador || null,
        situacao: r.situacao || null, data: r.dataRegistro || null
      })),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────────────────────────────────────

// Índice em memória p/ recuperação de consulta paga (chave: "PLACA|email").
// ⚠️ Volátil: zera a cada restart/deploy. Para persistir de verdade, usar um DB.
const _consultasPorChave = new Map();
function chaveConsulta(placa, email) {
  return String(placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '') +
         '|' + String(email || '').trim().toLowerCase();
}

// Formata a resposta "completa" (wdapi2 básico + FutureData premium).
// Usado pela rota /completa e pela /recuperar.
function formatarCompleta(d, futuredataDados, placa) {
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
    premium:          futuredataDados ? mapearFutureData(futuredataDados) : null
  };
}

// Consulta básica — wdapi2 (gratuita, antes do pagamento)
app.get('/api/consulta/basica/:placa', async (req, res) => {
  const placa = req.params.placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!placaValida(placa))
    return res.status(400).json({ erro: 'Formato de placa inválido.' });

  try {
    const d = await httpGet(
      `https://wdapi2.com.br/consulta/${placa}/${process.env.WDAPI_TOKEN}`
    );

    res.json({
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
    });
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
  const { plano, placa, email, nome, cpf, extras } = req.body;
  // Marca se o upsell de Leilão foi selecionado (para disparar a BrasilCredit no pós-pagamento).
  const querLeilao = Array.isArray(extras) && extras.some(x => String(x).toLowerCase().includes('leil'));
  const planos = {
    basico:   { valor: 19.90, descricao: 'Consulta Veicular Básica'   },
    simples:  { valor: 29.90, descricao: 'Consulta Veicular Simples'  },
    completo: { valor: 1.99, descricao: 'Consulta Veicular Completa' } // TESTE: era 49.90
  };
  const p = planos[plano];
  if (!p) return res.status(400).json({ erro: 'Plano inválido.' });

  try {
    const idempotencyKey = `${placa}-${plano}-${Date.now()}`;
    const pagamento = await httpPost(
      'https://api.mercadopago.com/v1/payments',
      {
        transaction_amount: p.valor,
        description: `${p.descricao} — Placa ${placa}`,
        payment_method_id: 'pix',
        payer: {
          email: email || 'cliente@sosbuscasonline.com.br',
          first_name: nome?.split(' ')[0] || 'Cliente',
          last_name:  nome?.split(' ').slice(1).join(' ') || 'SOS',
          identification: { type: 'CPF', number: cpf?.replace(/\D/g,'') || '00000000000' }
        },
        metadata: { placa, plano, leilao: querLeilao ? '1' : '0' }
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
      valor:          p.valor,
      descricao:      p.descricao
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

      // FutureData dispara em BACKGROUND (não bloqueia a resposta do status).
      // Retorna null enquanto processa; quando pronto, out.premium já vem preenchido
      // — é assim que o frontend sabe que o relatório está pronto p/ redirecionar.
      const premium = bgCache(_premiumCache, _premiumPending, id, () => montarConsultaPremium(placa));
      if (premium && d.payer?.email) {
        _consultasPorChave.set(chaveConsulta(placa, d.payer.email), premium); // indexa p/ /recuperar
      }
      out.premium = premium;

      // Upsell de Leilão (BrasilCredit) — também em background, só se foi comprado
      if (d.metadata?.leilao === '1') {
        out.leilao = bgCache(_leilaoCache, _leilaoPending, id, () => consultarLeilao(placa));
      }
    }

    res.json(out);
  } catch (err) {
    console.error('[status]', err.message);
    res.status(500).json({ erro: 'Erro ao verificar pagamento.' });
  }
});

// Consulta premium (FutureData + wdapi2) — só após pagamento aprovado.
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
    if (pag.payer?.email) _consultasPorChave.set(chaveConsulta(placaU, pag.payer.email), resultado);
    res.json(resultado);
  } catch (err) {
    console.error('[premium]', err.message);
    res.status(500).json({ erro: 'Erro ao consultar.' });
  }
});

// Consulta completa pós-pagamento — wdapi2 + FutureData
app.get('/api/consulta/completa/:placa/:pagamento_id', async (req, res) => {
  const { placa, pagamento_id } = req.params;

  try {
    // 1. Confirma pagamento aprovado
    const pag = await mpGet(`/v1/payments/${pagamento_id}`);
    if (pag.status !== 'approved')
      return res.status(402).json({ erro: 'Pagamento não confirmado.' });
    if (pag.metadata?.placa?.toUpperCase() !== placa.toUpperCase())
      return res.status(403).json({ erro: 'Placa não corresponde ao pagamento.' });

    // 2. Reaproveita o resultado já disparado no pós-pagamento (evita reconsultar
    //    wdapi2 + FutureData). Se ainda estiver processando, espera a MESMA promise.
    const key = String(pagamento_id);
    let resultado = _premiumCache.get(key);
    if (!resultado && _premiumPending.get(key)) resultado = await _premiumPending.get(key);
    if (!resultado) {
      resultado = await montarConsultaPremium(placa);
      _premiumCache.set(key, resultado);
    }

    // 3. Retorna no formato /completa (mesmo usado pela /recuperar)
    res.json(formatarCompleta(resultado.basico, resultado.futuredata, placa));

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
    // 2. Buscar no índice de pagamentos aprovados por placa + email
    const chave = chaveConsulta(placaU, email);
    let resultado = _consultasPorChave.get(chave);

    // 5. Não encontrou nenhum pagamento para essa placa+email
    if (!resultado) {
      return res.json({ found: false });
    }

    // 4. Encontrou o pagamento, mas sem os dados da FutureData → gera agora
    if (!resultado.futuredata) {
      try {
        resultado = await montarConsultaPremium(placaU);
        _consultasPorChave.set(chave, resultado);
      } catch (e) {
        console.error('[recuperar] regerar premium:', e.message);
      }
    }

    // 3. Retorna os dados unificados (mesmo formato da /completa)
    const dados = formatarCompleta(resultado.basico, resultado.futuredata, placaU);
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

// TEMPORARIO (debug): IP de saida do servidor — util p/ whitelist de APIs (ex.: BrasilCredit)
app.get('/api/meu-ip', async (req, res) => {
  try {
    const d = await httpGet('https://api.ipify.org?format=json');
    res.json(d);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao obter IP', msg: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
