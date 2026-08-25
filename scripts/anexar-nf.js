#!/usr/bin/env node
// robo-anexar-nf: le itens de fila-anexos/pendentes/*.json e anexa cada um no
// motorista certo (d.anexosEntrega) direto no Supabase, sem depender de navegador.
// Segredos: SUPABASE_URL, SUPABASE_KEY (mesmo esquema documentado pra outros robos
// do painel). Este script nunca deve imprimir os segredos.

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const QUADRO = process.env.QUADRO || 'transload';
const DRY = process.env.MODO_SECO === 'true' || process.env.MODO_SECO === '1';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltam segredos: SUPABASE_URL / SUPABASE_KEY.');
  process.exit(1);
}

// Mesma logica do index.html (slug/normalizePlaca) -- tem que bater exatamente,
// senao o anexo fica gravado numa chave que o card nao reconhece.
function slug(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function normalizePlaca(p) {
  return String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const DIR = path.join(__dirname, '..', 'fila-anexos', 'pendentes');
const PROC = path.join(__dirname, '..', 'fila-anexos', 'processados');

function sbHeaders(extra) {
  return Object.assign(
    {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    extra || {}
  );
}

async function lerLinha() {
  const url =
    SUPABASE_URL + '/rest/v1/painel?id=eq.' + encodeURIComponent(QUADRO) + '&select=dados,atualizado_em';
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('GET falhou: ' + r.status + ' ' + (await r.text()));
  const j = await r.json();
  if (!j[0]) throw new Error('Linha "' + QUADRO + '" nao existe no Supabase.');
  return j[0]; // { dados, atualizado_em }
}

// Grava com CAS (compare-and-swap) igual ao robo de rastreio: le, muta, tenta
// gravar condicionado ao carimbo lido; se alguem gravou no meio do caminho,
// re-le e tenta de novo. Evita apagar uma edicao humana concorrente.
async function gravarComCAS(mutar, tentativas) {
  tentativas = tentativas || 5;
  for (let i = 0; i < tentativas; i++) {
    const linha = await lerLinha();
    const dados = linha.dados;
    const resultado = mutar(dados);
    if (!resultado || resultado.pulou) return resultado || { pulou: true };
    if (DRY) {
      console.log('[modo_seco] gravaria ' + JSON.stringify(dados).length + ' bytes, sem gravar de fato.');
      return { ok: true, seco: true };
    }
    const url =
      SUPABASE_URL +
      '/rest/v1/painel?id=eq.' +
      encodeURIComponent(QUADRO) +
      '&atualizado_em=eq.' +
      encodeURIComponent(linha.atualizado_em);
    const r = await fetch(url, {
      method: 'PATCH',
      headers: sbHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ dados: dados, por: 'robo-anexar-nf' }),
    });
    if (!r.ok) throw new Error('PATCH falhou: ' + r.status + ' ' + (await r.text()));
    const arr = await r.json();
    if (arr.length) return { ok: true };
    console.log('Conflito de gravacao (tentativa ' + (i + 1) + '/' + tentativas + '), relendo...');
  }
  throw new Error('Nao consegui gravar apos ' + tentativas + ' tentativas (conflito repetido).');
}

function acharMotorista(dados, placa) {
  const pn = normalizePlaca(placa);
  const listas = [dados.motoristas || [], dados.historico || []];
  for (const lista of listas) {
    const d = lista.find((x) => normalizePlaca(x.placa) === pn);
    if (d) return d;
  }
  return null;
}

async function processarItem(item) {
  const { placa, cliente, destino, nome, tipo, dataUrl } = item;
  if (!placa || !cliente || !destino || !dataUrl) {
    throw new Error('Item incompleto (precisa de placa, cliente, destino e dataUrl).');
  }
  const chave = slug(cliente + ' ' + destino);

  return gravarComCAS((dados) => {
    const d = acharMotorista(dados, placa);
    if (!d) {
      console.log('Placa ' + placa + ' nao encontrada (nem ativa nem no historico) -- deixando na fila.');
      return { pulou: true };
    }
    if (!d.anexosEntrega) d.anexosEntrega = {};
    if (!d.anexosEntrega[chave]) d.anexosEntrega[chave] = [];
    d.anexosEntrega[chave].push({
      nome: nome || 'NF ' + new Date().toISOString(),
      tipo: tipo || 'application/pdf',
      dataUrl: dataUrl,
      criadoEm: Date.now(),
    });
    // Bumpa pro futuro (mesma tecnica documentada) pra sobreviver ao merge
    // do navegador (mesclarQuadro so aceita remoto se updatedAt for maior).
    d.updatedAt = Date.now() + 60000;
    return { ok: true };
  });
}

async function main() {
  if (!fs.existsSync(DIR)) {
    console.log('Pasta fila-anexos/pendentes/ nao existe. Nada a fazer.');
    return;
  }
  const arquivos = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  if (!arquivos.length) {
    console.log('Fila vazia.');
    return;
  }
  if (!DRY) fs.mkdirSync(PROC, { recursive: true });

  let ok = 0,
    falhou = 0,
    pulou = 0;
  for (const f of arquivos) {
    const p = path.join(DIR, f);
    try {
      const item = JSON.parse(fs.readFileSync(p, 'utf8'));
      const r = await processarItem(item);
      if (r && r.pulou) {
        pulou++;
        console.log('PULOU ' + f + ' (placa nao encontrada, fica na fila)');
        continue;
      }
      ok++;
      console.log('OK ' + f);
      if (!DRY) fs.renameSync(p, path.join(PROC, f));
    } catch (e) {
      falhou++;
      console.error('ERRO em ' + f + ': ' + e.message);
    }
  }
  console.log('Resumo: ' + ok + ' ok, ' + falhou + ' falharam, ' + pulou + ' pulados.');
  if (falhou > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Erro fatal: ' + e.message);
  process.exit(1);
});
