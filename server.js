require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const https    = require('https');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cors({
  origin: [
    'https://bp-sos.vercel.app',
    'https://sospc.vercel.app',
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

  let res;
  try {
    res = await httpPost(process.env.FUTURE_DATA_API_AUTH_URL, {
      username: process.env.FUTURE_DATA_API_USERNAME,
      password: process.env.FUTURE_DATA_API_PASSWORD
    });
  } catch (e) {
    throw new Error('FutureData auth failed');
  }

  const token = res && (res.token || res.access_token);
  if (!token) throw new Error('FutureData auth failed');

  _fdToken = token;
  _fdTokenExpires = now + 30 * 60 * 1000; // cache de 30 minutos
  console.log('[FutureData] Token renovado');
  return _fdToken;
}

async function consultarFutureData(placa) {
  const token = await getFutureDataToken();

  const res = await httpPost(
    `${process.env.FUTURE_DATA_API_BASE_URL}/veicular-nacional-v2`,
    { placa },
    { 'x-access-token': token }
  );

  if (!res.success) {
    throw new Error(res.msg || 'Erro na consulta FutureData');
  }

  return res.dados;
}

// Monta a consulta premium unificada (wdapi2 básico + FutureData), usada tanto
// pela rota POST /api/consulta/premium quanto pelo fluxo de pagamento aprovado.
const _premiumCache = new Map(); // pagamento_id -> resultado premium (em memória)

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

// Mapeia todos os campos da FutureData para um objeto padronizado
function mapearFutureData(fd) {
  if (!fd) return null;
  return {
    // Proprietário (dados premium)
    proprietario:          fd.nome_proprietario              || null,
    cpf_cnpj_proprietario: fd.cpf_cnpj_proprietario         || null,
    tipo_doc_proprietario: fd.tipodocproprietario           || null,

    // Identificação do veículo
    renavam:               fd.renavam                       || null,
    chassi_completo:       fd.chassi                        || null,
    motor:                 fd.motor                         || null,
    placa:                 fd.placa                         || null,
    municipio:             fd.municipio                     || null,
    uf:                    fd.uf                            || null,
    marca:                 fd.marca                         || null,
    modelo:                fd.modelo                        || null,
    ano_fabricacao:        fd.veianofabr                    || null,
    ano_modelo:            fd.veianomodelo                  || null,
    cor:                   fd.cor                           || null,
    combustivel:           fd.combustivel                   || null,
    tipo:                  fd.tipo                          || null,
    especie:               fd.especie                       || null,
    categoria:             fd.categoria                     || null,
    procedencia:           fd.veiprocedencia                || null,

    // Dados técnicos
    potencia:              fd.potencia                      || null,
    cilindrada:            fd.cilindrada                    || null,
    capacidade_carga:      fd.capacidadecarga               || null,
    capacidade_passag:     fd.capacidadepassag              || null,
    eixos:                 fd.eixos                         || null,
    pbt:                   fd.pbt                           || null,
    cmt:                   fd.cmt                           || null,
    carroceria:            fd.carroceria                    || null,
    tipo_montagem:         fd.tipomontagem                  || null,
    numero_motor:          fd.motor                         || null,
    numero_cambio:         fd.numero_caixacambio            || null,
    numero_carroceria:     fd.numero_carroceria             || null,
    numero_eixo_traseiro:  fd.numero_eixotraseirodif        || null,
    numero_terceiro_eixo:  fd.numero_terceiroeixo           || null,
    tipo_remarcacao_chassi:fd.tiporemarcchassi              || null,

    // Faturamento
    tipo_doc_faturado:     fd.tipodocumentofaturado         || null,
    cpf_cnpj_faturado:     fd.cpfcnpjfaturado              || null,
    uf_faturado:           fd.uffaturado                    || null,
    tipo_doc_importadora:  fd.tipodocumentoimportadora      || null,

    // Situação
    situacao_veiculo:      fd.situacaoveic                  || null,
    ocorrencia_roubo_furto:fd.ocorrencia                    || null,
    ultima_atualizacao:    fd.ultimaatualizacao             || null,

    // Restrições principais
    restricao01:           fd.restricao01                   || null,
    restricao02:           fd.restricao02                   || null,
    restricao03:           fd.restricao03                   || null,
    restricao04:           fd.restricao04                   || null,

    // Comunicado de venda e Renajud
    comunicado_venda:      fd.indicadorcomunicacaodevendas  || null,
    restricao_renajud:     fd.indicadorrestricaorenajud     || null,

    // Restrição financeira (gravame)
    restricao_tipo_transacao: fd.restricaotipotransacao     || null,
    restricao_financeira:     fd.restricoesrestricaofinan   || null,
    restricao_nome_agente:    fd.restricaonomeagente        || null,
    restricao_financiado:     fd.restricaofinanciado        || null,
    restricao_cpf_financiado: fd.restricaocpfcnpjfinanciado|| null,
    restricao_data_inclusao:  fd.restricaodatainclusao      || null,

    // Outras restrições
    outras_restricoes: [
      fd.outras_restricoes_01,
      fd.outras_restricoes_02,
      fd.outras_restricoes_03,
      fd.outras_restricoes_04,
      fd.outras_restricoes_05,
      fd.outras_restricoes_06,
      fd.outras_restricoes_07,
      fd.outras_restricoes_08
    ].filter(r => r && r !== 'NADA CONSTA')
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────────────────────────────────────────

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
  const { plano, placa, email, nome, cpf } = req.body;
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
        metadata: { placa, plano }
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
      let premium = _premiumCache.get(id);
      if (!premium) {
        const placa = d.metadata.placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
        try {
          premium = await montarConsultaPremium(placa);
          _premiumCache.set(id, premium); // cache p/ não reconsultar a cada polling
        } catch (e) {
          console.error('[status/premium]', e.message);
          premium = null;
        }
      }
      out.premium = premium;
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

    // 2. Consultas em paralelo (wdapi2 + FutureData)
    const [wdapi, futuredata] = await Promise.allSettled([
      httpGet(`https://wdapi2.com.br/consulta/${placa}/${process.env.WDAPI_TOKEN}`),
      consultarFutureData(placa)
    ]);

    const d  = wdapi.status === 'fulfilled' ? wdapi.value : {};
    const fd = futuredata.status === 'fulfilled'
      ? mapearFutureData(futuredata.value)
      : null;

    if (futuredata.status === 'rejected') {
      console.error('[FutureData]', futuredata.reason?.message);
    }

    // 3. Retorna tudo junto
    res.json({
      // ── wdapi2
      marca:            d.MARCA        || null,
      modelo:           d.MODELO       || null,
      submodelo:        d.SUBMODELO    || null,
      versao:           d.VERSAO       || null,
      ano_fab:          d.ano          || null,
      ano_modelo:       d.anoModelo    || null,
      chassi:           d.chassi       || null,
      cor:              d.cor          || null,
      origem:           d.origem       || null,
      placa:            d.placa        || placa,
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

      // ── FutureData (dados premium)
      premium: fd
    });

  } catch (err) {
    console.error('[completa]', err.message);
    res.status(500).json({ erro: 'Erro ao consultar.' });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
