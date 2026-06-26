require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
const https   = require('https');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cors({ origin: '*' }));

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: { erro: 'Muitas consultas. Aguarde alguns minutos.' }
});
app.use('/api/consulta', limiter);

// ── helpers ──────────────────────────────────────────────────────────────────
function placaValida(placa) {
  return /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa.toUpperCase());
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Resposta inválida da API')); }
      });
    }).on('error', reject);
  });
}

function httpPost(url, body, token, idempotencyKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const urlObj  = new URL(url);
    const headers = {
      'Content-Type':   'application/json',
      'Authorization':  `Bearer ${token}`,
      'Content-Length': Buffer.byteLength(payload)
    };
    if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

    const req = https.request(
      { hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Resposta inválida do Mercado Pago')); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function mpGet(path) {
  return new Promise((resolve, reject) => {
    https.request(
      {
        hostname: 'api.mercadopago.com',
        path,
        method:  'GET',
        headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      },
      (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Resposta inválida do Mercado Pago')); }
        });
      }
    ).on('error', reject).end();
  });
}

// Escolhe o melhor item da FIPE (maior score)
function melhorFipe(dados) {
  const lista = dados.fipe?.dados;
  if (!lista || !lista.length) return null;
  const best = lista.reduce((a, b) => (b.score > a.score ? b : a), lista[0]);
  return {
    codigo:      best.codigo_fipe       || null,
    valor:       best.texto_valor       || null,
    modelo:      best.texto_modelo      || null,
    marca:       best.texto_marca       || null,
    combustivel: best.combustivel       || null,
    ano_modelo:  best.ano_modelo        || null,
    referencia:  best.mes_referencia    || null,
    score:       best.score             || null
  };
}

// ── CONSULTA BÁSICA (gratuita) ────────────────────────────────────────────────
app.get('/api/consulta/basica/:placa', async (req, res) => {
  const placa = req.params.placa.toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!placaValida(placa))
    return res.status(400).json({ erro: 'Formato de placa inválido. Use AAA0X00 ou AAA0000.' });

  try {
    const d = await httpGet(
      `https://wdapi2.com.br/consulta/${placa}/${process.env.WDAPI_TOKEN}`
    );

    res.json({
      // ── Identificação principal
      marca:           d.MARCA        || null,
      modelo:          d.MODELO       || null,
      submodelo:       d.SUBMODELO    || null,
      versao:          d.VERSAO       || null,
      marcaModelo:     d.marcaModelo  || null,
      ano_fab:         d.ano          || null,
      ano_modelo:      d.anoModelo    || null,
      chassi:          d.chassi       || null,
      cor:             d.cor          || null,
      origem:          d.origem       || null,
      placa:           d.placa        || placa,
      placa_alternativa: d.placa_alternativa || null,
      situacao:        d.situacao     || null,
      codigoSituacao:  d.codigoSituacao || null,
      municipio:       d.municipio    || null,
      uf:              d.uf           || null,
      logo:            d.logo         || null,

      // ── Extra (veículo)
      combustivel:         d.extra?.combustivel         || null,
      cilindradas:         d.extra?.cilindradas         || null,
      especie:             d.extra?.especie             || null,
      tipo_veiculo:        d.extra?.tipo_veiculo        || null,
      tipo_carroceria:     d.extra?.tipo_carroceria     || null,
      tipo_montagem:       d.extra?.tipo_montagem       || null,
      caixa_cambio:        d.extra?.caixa_cambio        || null,
      eixos:               d.extra?.eixos               || null,
      terceiro_eixo:       d.extra?.terceiro_eixo       || null,
      quantidade_passageiro: d.extra?.quantidade_passageiro || null,
      peso_bruto_total:    d.extra?.peso_bruto_total    || null,
      cap_maxima_tracao:   d.extra?.cap_maxima_tracao   || null,
      nacionalidade:       d.extra?.nacionalidade       || null,
      segmento:            d.extra?.segmento            || null,
      sub_segmento:        d.extra?.sub_segmento        || null,

      // ── Extra (situação / doc)
      situacao_chassi:     d.extra?.situacao_chassi     || null,
      situacao_veiculo:    d.extra?.situacao_veiculo    || null,
      tipo_doc_prop:       d.extra?.tipo_doc_prop       || null,
      tipo_doc_faturado:   d.extra?.tipo_doc_faturado   || null,
      tipo_doc_importadora: d.extra?.tipo_doc_importadora || null,
      uf_placa:            d.extra?.uf_placa            || null,
      uf_faturado:         d.extra?.uf_faturado         || null,
      placa_modelo_novo:   d.extra?.placa_modelo_novo   || null,
      placa_modelo_antigo: d.extra?.placa_modelo_antigo || null,

      // ── FIPE (melhor score)
      fipe: melhorFipe(d)
    });

  } catch (err) {
    console.error('[basica]', err.message);
    res.status(500).json({ erro: 'Erro ao consultar. Tente novamente.' });
  }
});

// ── PROXY LOGO (evita CORS do browser) ───────────────────────────────────────
app.get('/api/logo', (req, res) => {
  const { url } = req.query;
  if (!url || !url.startsWith('https://apiplacas.com.br/'))
    return res.status(400).end();

  https.get(url, (logoRes) => {
    res.setHeader('Content-Type', logoRes.headers['content-type'] || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    logoRes.pipe(res);
  }).on('error', () => res.status(404).end());
});

// ── CRIAR PAGAMENTO PIX ───────────────────────────────────────────────────────
app.post('/api/pagamento/criar', async (req, res) => {
  const { plano, placa, email, nome, cpf } = req.body;

  const planos = {
    basico:   { valor: 19.90, descricao: 'Consulta Veicular Básica'    },
    simples:  { valor: 29.90, descricao: 'Consulta Veicular Simples'   },
    completo: { valor: 49.90, descricao: 'Consulta Veicular Completa'  }
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
          first_name: nome ? nome.split(' ')[0] : 'Cliente',
          last_name:  nome ? nome.split(' ').slice(1).join(' ') || 'SOS' : 'SOS',
          identification: {
            type:   'CPF',
            number: cpf ? cpf.replace(/\D/g, '') : '00000000000'
          }
        },
        metadata: { placa, plano }
      },
      process.env.MP_ACCESS_TOKEN,
      idempotencyKey
    );

    if (pagamento.error) {
      console.error('[MP ERRO]', JSON.stringify(pagamento));
      throw new Error(pagamento.message || pagamento.error);
    }

    console.log('[MP OK] id:', pagamento.id, 'status:', pagamento.status);

    res.json({
      id:             pagamento.id,
      status:         pagamento.status,
      qr_code:        pagamento.point_of_interaction?.transaction_data?.qr_code         || null,
      qr_code_base64: pagamento.point_of_interaction?.transaction_data?.qr_code_base64  || null,
      valor:          p.valor,
      descricao:      p.descricao
    });

  } catch (err) {
    console.error('[criar pagamento]', err.message);
    res.status(500).json({ erro: err.message || 'Erro ao criar pagamento.' });
  }
});

// ── STATUS DO PAGAMENTO ───────────────────────────────────────────────────────
app.get('/api/pagamento/status/:id', async (req, res) => {
  try {
    const d = await mpGet(`/v1/payments/${req.params.id}`);
    res.json({
      id:     d.id,
      status: d.status,
      plano:  d.metadata?.plano,
      placa:  d.metadata?.placa
    });
  } catch (err) {
    console.error('[status]', err.message);
    res.status(500).json({ erro: 'Erro ao verificar pagamento.' });
  }
});

// ── CONSULTA COMPLETA (pós-pagamento) ────────────────────────────────────────
app.get('/api/consulta/completa/:placa/:pagamento_id', async (req, res) => {
  const { placa, pagamento_id } = req.params;

  try {
    // 1. Confirma pagamento aprovado
    const pag = await mpGet(`/v1/payments/${pagamento_id}`);
    if (pag.status !== 'approved')
      return res.status(402).json({ erro: 'Pagamento não confirmado.' });
    if (pag.metadata?.placa?.toUpperCase() !== placa.toUpperCase())
      return res.status(403).json({ erro: 'Placa não corresponde ao pagamento.' });

    // 2. Busca dados completos
    const d = await httpGet(
      `https://wdapi2.com.br/consulta/${placa}/${process.env.WDAPI_TOKEN}`
    );

    res.json({
      // Mesmos campos da rota básica
      marca:           d.MARCA        || null,
      modelo:          d.MODELO       || null,
      submodelo:       d.SUBMODELO    || null,
      versao:          d.VERSAO       || null,
      marcaModelo:     d.marcaModelo  || null,
      ano_fab:         d.ano          || null,
      ano_modelo:      d.anoModelo    || null,
      chassi:          d.chassi       || null,
      cor:             d.cor          || null,
      origem:          d.origem       || null,
      placa:           d.placa        || placa,
      placa_alternativa: d.placa_alternativa || null,
      situacao:        d.situacao     || null,
      codigoSituacao:  d.codigoSituacao || null,
      municipio:       d.municipio    || null,
      uf:              d.uf           || null,
      logo:            d.logo         || null,
      combustivel:     d.extra?.combustivel         || null,
      cilindradas:     d.extra?.cilindradas         || null,
      especie:         d.extra?.especie             || null,
      tipo_veiculo:    d.extra?.tipo_veiculo        || null,
      tipo_carroceria: d.extra?.tipo_carroceria     || null,
      tipo_montagem:   d.extra?.tipo_montagem       || null,
      eixos:           d.extra?.eixos               || null,
      quantidade_passageiro: d.extra?.quantidade_passageiro || null,
      peso_bruto_total: d.extra?.peso_bruto_total   || null,
      cap_maxima_tracao: d.extra?.cap_maxima_tracao || null,
      nacionalidade:   d.extra?.nacionalidade       || null,
      segmento:        d.extra?.segmento            || null,
      sub_segmento:    d.extra?.sub_segmento        || null,
      situacao_chassi: d.extra?.situacao_chassi     || null,
      situacao_veiculo: d.extra?.situacao_veiculo   || null,
      tipo_doc_prop:   d.extra?.tipo_doc_prop       || null,
      uf_placa:        d.extra?.uf_placa            || null,
      placa_modelo_novo: d.extra?.placa_modelo_novo || null,
      placa_modelo_antigo: d.extra?.placa_modelo_antigo || null,
      fipe: melhorFipe(d)
    });

  } catch (err) {
    console.error('[completa]', err.message);
    res.status(500).json({ erro: 'Erro ao consultar.' });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
