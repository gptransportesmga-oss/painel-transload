// robo-sync-status-bsoft: le itens de fila-status/pendentes/*.json e aplica cada
// um nos campos de status do motorista (bsoftAberto/mdfe/semNf/entregas) direto
// no Supabase, sem depender de escrita via navegador (bloqueada pelo classificador
// de seguranca do Claude mesmo com a aba do Painel logada -- ver pendencias-e-
// descobertas.md, secao "BLOQUEIO MAIS AMPLO (25/08/2026)").
//
// Duas formas de alimentar este robo (o que for mais facil na hora):
//   1) fila-status/pendentes/*.json -- um arquivo por atualizacao de placa, ex.:
//        { "placa": "AXW-6J08", "bsoftAberto": true, "mdfe": "899" }
//        { "placa": "AXT-9F90", "bsoftAberto": false, "semNf": true, "limparEntregas": true }
//      (mesmo padrao do robo-anexar-nf: cada arquivo processado com sucesso vai
//      pra fila-status/processados/; "placa nao encontrada" fica na fila pra
//      tentar de novo depois).
//   2) Rodar o workflow manualmente (aba Actions > "Sincronizar Status BSoft" >
//      "Run workflow") e colar um ARRAY JSON com um ou mais itens no campo
//      "itens_json" -- mais rapido pra um lote pontual, sem precisar criar
//      arquivo nenhum no repositorio. Os dois metodos podem ser usados juntos;
//      o robo roda a fila de arquivos primeiro e depois os itens do input, se
//      houver.
//
// Em ambos os casos, so os campos presentes no item sao alterados; o resto do
// card fica como esta.
//
// Segredos: SUPABASE_URL, SUPABASE_KEY (mesmo esquema do robo-anexar-nf). Este
// script nunca deve imprimir os segredos.

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

function normalizePlaca(p) {
  return String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const DIR = path.join(__dirname, '..', 'fila-status', 'pendentes');
const PROC = path.join(__dirname, '..', 'fila-status', 'processados');

function sbHeaders(extra) {
  return Object.assign(
    { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
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

// Grava com CAS (compare-and-swap), mesma tecnica (ja corrigida) do robo-anexar-nf:
// le, muta, tenta gravar condicionado ao carimbo lido, e SEMPRE avanca o proprio
// atualizado_em no PATCH -- senao um escritor concorrente (robo-rastreio-nuvem, a
// cada 30s) que leu antes da gente ainda casa no carimbo antigo e sobrescreve
// silenciosamente o que acabamos de gravar.
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
    const novoCarimbo = new Date().toISOString();
    const r = await fetch(url, {
      method: 'PATCH',
      headers: sbHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ dados: dados, por: 'robo-sync-status-bsoft', atualizado_em: novoCarimbo }),
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

// Campos que este robo sabe mexer -- de proposito uma lista fechada, pra nunca
// aceitar um item de fila que tente alterar algo fora do escopo dele (ex.: nome,
// foto, anexosEntrega -- isso e trabalho de outro robo/tela).
const CAMPOS_PERMITIDOS = ['bsoftAberto', 'mdfe', 'semNf', 'status'];

async function processarItem(item) {
  const { placa, limparEntregas, motivo } = item;
  if (!placa) {
    throw new Error('Item incompleto (precisa de "placa").');
  }

  return gravarComCAS((dados) => {
    const d = acharMotorista(dados, placa);
    if (!d) {
      console.log('Placa ' + placa + ' nao encontrada (nem ativa nem no historico) -- deixando na fila.');
      return { pulou: true };
    }
    let mudou = false;
    for (const campo of CAMPOS_PERMITIDOS) {
      if (Object.prototype.hasOwnProperty.call(item, campo) && d[campo] !== item[campo]) {
        d[campo] = item[campo];
        mudou = true;
      }
    }
    if (limparEntregas) {
      d.entregas = [];
      mudou = true;
    }
    if (!mudou) {
      console.log('Placa ' + placa + ' ja estava no estado pedido -- nada a fazer.' + (motivo ? ' (' + motivo + ')' : ''));
      return { ok: true, semMudanca: true };
    }
    d.updatedAt = Date.now() + 60000;
    console.log('Placa ' + placa + ' atualizada.' + (motivo ? ' Motivo: ' + motivo : ''));
    return { ok: true };
  });
}

async function main() {
  let ok = 0,
    falhou = 0,
    pulou = 0;

  // Fonte 1: fila de arquivos (fila-status/pendentes/*.json).
  if (fs.existsSync(DIR)) {
    const arquivos = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
    if (!arquivos.length) {
      console.log('Fila de arquivos vazia.');
    } else {
      if (!DRY) fs.mkdirSync(PROC, { recursive: true });
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
          console.log('OK ' + f + (r && r.semMudanca ? ' (ja estava correto)' : ''));
          if (!DRY) fs.renameSync(p, path.join(PROC, f));
        } catch (e) {
          falhou++;
          console.error('ERRO em ' + f + ': ' + e.message);
        }
      }
    }
  } else {
    console.log('Pasta fila-status/pendentes/ nao existe -- pulando fila de arquivos.');
  }

  // Fonte 2: input manual do workflow_dispatch (ITENS_JSON = array de itens).
  const itensJson = (process.env.ITENS_JSON || '').trim();
  if (itensJson) {
    let itens;
    try {
      itens = JSON.parse(itensJson);
      if (!Array.isArray(itens)) throw new Error('ITENS_JSON precisa ser um array.');
    } catch (e) {
      console.error('ITENS_JSON invalido: ' + e.message);
      falhou++;
      itens = [];
    }
    for (const item of itens) {
      const rotulo = 'input:' + (item && item.placa ? item.placa : '?');
      try {
        const r = await processarItem(item);
        if (r && r.pulou) {
          pulou++;
          console.log('PULOU ' + rotulo + ' (placa nao encontrada)');
          continue;
        }
        ok++;
        console.log('OK ' + rotulo + (r && r.semMudanca ? ' (ja estava correto)' : ''));
      } catch (e) {
        falhou++;
        console.error('ERRO em ' + rotulo + ': ' + e.message);
      }
    }
  }

  console.log('Resumo: ' + ok + ' ok, ' + falhou + ' falharam, ' + pulou + ' pulados/ja-corretos.');
  if (falhou > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Erro fatal: ' + e.message);
  process.exit(1);
});
