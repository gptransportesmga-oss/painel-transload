#!/usr/bin/env node
'use strict';


// robo-painel-motor: mantem o Painel de Viagens funcionando sem depender do
// navegador aberto, para TUDO que nao seja o ciclo BSoft (esse continua manual/
// assistido por Claude, por causa da autenticacao em duas etapas do BSoft e da
// falta de uma API confiavel de la).
//
// A cada execucao (agendada de 5 em 5 min pelo GitHub Actions), faz o que hoje
// so acontece com a aba do Painel aberta no navegador:
//
//   1. Login no Ca2Track e busca a frota inteira (mesma API que o navegador usa
//      quando "Rastreamento automatico" esta ligado).
//   2. Atualiza d.tracking de cada caminhao ja no quadro (casado por placa) --
//      pula quem ja esta "finalizado" (ver nota mais abaixo sobre o motivo).
//   3. Cria um card novo ("carregando") para qualquer placa que aparecer no
//      rastreio e NUNCA tiver existido nem em S.drivers nem em S.arquivo --
//      mesma regra do PATCH_ESPELHAMENTO v3 do navegador: nunca ressuscita uma
//      placa ja arquivada sozinho, so o ciclo BSoft faz isso.
//   4. Recalcula a conclusao automatica de entrega por proximidade (mesma
//      logica do processarEntregas/PATCH_ENTREGA_AUTO_FIX v1 do navegador).
//   5. Recalcula o tempo parado por cliente (mesma logica do __tickTempos).
//   6. Recalcula d.status (mesma logica do statusAutomatico ao vivo, incluindo
//      a regra de 26/08/2026 de ficar "carregando" ate ter entrega importada).
//   7. Arquiva quem esta "finalizado" ha 5+ minutos -- como este script nao tem
//      localStorage, usa d.updatedAt como marca de "desde quando esta assim"
//      (por isso o passo 2 pula os finalizados: se atualizasse o tracking
//      deles, o updatedAt seria bumped e o arquivamento nunca aconteceria).
//      Ao remover, grava a placa em dados.placasEncerradas (so placa+timestamp)
//      pra nunca recriar essa ficha sozinho depois -- ver nota no passo 2.
//   0. (roda antes de tudo) Funde fichas duplicadas da mesma placa, caso duas
//      rotinas diferentes tenham criado card pra ela sem uma checar a outra
//      primeiro (achado em 28/08/2026 na AVW-7J79).
//
// NUNCA mexe em bsoftAberto / mdfe / semNf / entregas (a lista importada) --
// isso continua sendo o ciclo BSoft (rotina-atualizacao-bsoft.md, tocado por
// Claude, e o robo-sync-status-bsoft.js). As duas coisas convivem bem porque
// usam o mesmo mecanismo de CAS (compare-and-swap) contra o Supabase.
//
// Segredos necessarios (Settings > Secrets and variables > Actions):
//   - SUPABASE_URL, SUPABASE_KEY -- ja existem no repo (mesmos do
//     robo-sync-status-bsoft.js / robo-anexar-nf.js).
//   - CA2_USUARIO, CA2_SENHA -- login do Ca2Track (o mesmo e-mail/senha que
//     voce digita no proprio Painel, em Configuracoes > Rastreamento). Sao
//     NOVOS, precisam ser cadastrados.
//
// Este script nunca deve imprimir os segredos.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CA2_USUARIO = process.env.CA2_USUARIO;
const CA2_SENHA = process.env.CA2_SENHA;
const QUADRO = process.env.QUADRO || 'transload';
const DRY = process.env.MODO_SECO === 'true' || process.env.MODO_SECO === '1';

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Faltam segredos: SUPABASE_URL / SUPABASE_KEY.');
    process.exit(1);
}
if (!CA2_USUARIO || !CA2_SENHA) {
    console.error('Faltam segredos: CA2_USUARIO / CA2_SENHA.');
    process.exit(1);
}

const API_BASE = 'https://ca2soft.com.br/itransrisco';

// ---------------------------------------------------------------------------
// Utilidades replicadas do index.html (mesma logica, mesmo comportamento) --
// ver claude/rotina-atualizacao-bsoft.md e como-atualizar-o-painel.md no
// projeto "PAINEL DE VIAGENS" para o historico de cada uma dessas regras.
// ---------------------------------------------------------------------------

function normalizePlaca(p) { return String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function slug(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function norm(s) {
    return (s || '').toString().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const GENERICAS = new Set(['atacadista', 'atacado', 'comercio', 'comercial', 'alimentos', 'alimenticios',
                             'alimentacao', 'distribuidora', 'distribuicao', 'importadora', 'produtos', 'ltda', 'brasil', 'sociedade',
                             'limitada', 'industria', 'logistica', 'transportes', 'supermercados', 'supermercado', 'super', 'centro',
                             'posto', 'servicos', 'recuperacao', 'judicial', 'frigorifico', 'foods', 'filial']);

const RUA_GENERICAS = new Set(['rua', 'av', 'avenida', 'alameda', 'alam', 'rodovia', 'rod', 'travessa',
                                 'trav', 'estrada', 'via', 'praca', 'pca', 'ln', 'linha', 'km', 'prx', 'proximo', 'perto', 's n', 'sn']);

const PALAVRAS_GENERICAS = ['ALIMENTOS', 'ATACADISTA', 'ATACADO', 'DISTRIBUIDORA', 'DISTRIBUICAO',
                              'COMERCIAL', 'COMERCIO', 'SUPERMERCADO', 'SUPERMERCADOS', 'MERCADO', 'INDUSTRIA', 'INDUSTRIAL',
                              'TRANSPORTES', 'TRANSPORTE', 'LOGISTICA', 'SERVICOS', 'SERVICO', 'LTDA', 'EIRELI', 'FILIAL', 'CENTRO',
                              'ARMAZEM', 'DEPOSITO', 'PRODUTOS', 'BRASIL', 'NACIONAL', 'REDE', 'GRUPO', 'POSTO', 'AUTO', 'FRIGORIFICO',
                              'COOPERATIVA', 'COOP', 'ASSOCIADOS', 'EMPRESA', 'MATRIZ', 'LOJA', 'UNIDADE', 'SUPER', 'MAIS'];

const ALIAS_CLIENTES = { GTF: ['GONCALVES', 'TORTOLA'] };

const RAIO_CLIENTE_M = 200;
const VEL_PARADO_KMH = 5;
const ENTREGA_MIN_MINUTOS = 60;
const ENTREGA_HORA_INI = 8;
const ENTREGA_HORA_FIM = 18;
const HORAS_SEM_SINAL_FINALIZA = 5;
const ARQUIVA_APOS_MS = 60 * 60 * 1000;

function palavrasFortes(nome) {
    return slug(nome).split(' ').filter((w) => w.length >= 4 && !GENERICAS.has(w));
}

function palavrasRua(texto) {
    return slug(texto).split(' ').filter((w) => w.length >= 3 && !RUA_GENERICAS.has(w));
}

function parseDestino(destino) {
    const s = String(destino || '').trim();
    const m = s.match(/^(.*?)\s*\/\s*([A-Za-z]{2})$/);
    if (m) return { cidade: m[1].trim(), uf: m[2].toUpperCase() };
    if (/^[A-Za-z]{2}$/.test(s)) return { cidade: '', uf: s.toUpperCase() };
    return { cidade: s, uf: '' };
}

function parsePosicao(pos) {
    const s = String(pos || '').replace(/^prx\.?\s+/i, '').trim();
    if (!s) return { rua: '', cidade: '', uf: '' };
    const partes = s.split(',');
    const rua = (partes[0] || '').trim();
    const resto = partes.slice(1).join(',').trim();
    const m = resto.match(/^(.*?)\s*-\s*([A-Za-z]{2})$/);
    if (m) return { rua, cidade: m[1].trim(), uf: m[2].toUpperCase() };
    return { rua, cidade: resto, uf: '' };
}

function distanciaRefMetros(ref) {
    if (!ref) return null;
    const s = String(ref).trim();
    const m = s.match(/([\d.,]+)\s*(km|m)\b/i);
    if (!m) return /^em\s/i.test(s) ? 0 : null;
    const n = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
    if (isNaN(n)) return null;
    return /km/i.test(m[2]) ? n * 1000 : n;
}

function distintivos(s) {
    return norm(s).split(' ').filter((t) => t.length >= 4 && PALAVRAS_GENERICAS.indexOf(t) < 0);
}

function casarEntrega(ref, entregas) {
    let r = norm(ref);
    if (!r) return -1;
    Object.keys(ALIAS_CLIENTES).forEach((ap) => {
          if (new RegExp('\\b' + ap + '\\b').test(r)) r += ' ' + ALIAS_CLIENTES[ap].join(' ');
    });
    let melhor = -1, score = 0;
    (entregas || []).forEach((e, i) => {
          if (e.concluida) return;
          const tc = distintivos(e.cliente);
          if (!tc.length) return;
          const acertos = tc.filter((t) => r.indexOf(t) >= 0).length;
          if (acertos > score) { score = acertos; melhor = i; }
    });
    return score > 0 ? melhor : -1;
}

function emHorarioUtil(ts) {
    const d = new Date(ts);
    const dia = d.getDay();
    if (dia === 0 || dia === 6) return false;
    const h = d.getHours();
    return h > ENTREGA_HORA_INI && h < ENTREGA_HORA_FIM;
}

function semSinalHaHoras(d, horas) {
    if (!d || !d.tracking || !d.tracking.trackedAt) return false;
    return (Date.now() - d.tracking.trackedAt) > horas * 3600000;
}

function tKey(e) { return slug((e.cliente || '') + ' ' + (e.destino || '')); }

function entregaNaReferencia(d) {
    const t = d.tracking;
    if (!t || t.velocidade > 0) return -1;
    const pos = parsePosicao(t.posicao);
    const refTxt = slug((t.referencia || '') + ' ' + (t.posicao || ''));
    const ruasPos = palavrasRua(pos.rua);
    const l = d.entregas || [];
    let melhor = -1, melhorScore = 0;
    for (let i = 0; i < l.length; i++) {
          const e = l[i];
          if (e.concluida) continue;
          let score = 0;
          const pn = palavrasFortes(e.cliente);
          if (pn.length && pn.some((w) => refTxt.indexOf(w) !== -1)) score += 2;
          const ed = parseDestino(e.destino);
          const cidadeBate = ed.uf && pos.uf && ed.uf === pos.uf &&
                  (!ed.cidade || !pos.cidade || slug(pos.cidade).indexOf(slug(ed.cidade)) !== -1);
          if (cidadeBate) score += 1;
          if (e.rua) {
                  const pr = palavrasRua(e.rua);
                  if (pr.length && ruasPos.length && pr.some((w) => ruasPos.indexOf(w) !== -1)) score += 3;
          }
          if (score > melhorScore) { melhorScore = score; melhor = i; }
    }
    return melhorScore >= 2 ? melhor : -1;
}

function statusAutomatico(d) {
    if (d.semNf) return 'finalizado';
    if (d.status === 'finalizado') return 'finalizado';
    if ((d.status === 'em_rota' || d.status === 'no_cliente') &&
              semSinalHaHoras(d, HORAS_SEM_SINAL_FINALIZA)) return 'finalizado';
    if (entregaNaReferencia(d) >= 0) return 'no_cliente';
    if (!(d.entregas && d.entregas.length)) return 'carregando';
    if (d.tracking) return 'em_rota';
    return d.status;
}

// ---------------------------------------------------------------------------
// Ca2Track (mesma API que o navegador usa em "Rastreamento automatico")
// ---------------------------------------------------------------------------

function parseBrDateTime(str) {
    if (!str) return null;
    const m = String(str).trim().match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return new Date(m[3] + '-' + m[2] + '-' + m[1] + 'T' + m[4] + ':' + m[5] + ':' + m[6]).getTime();
}

function parseQualquerData(s) {
    if (!s) return null;
    const t = String(s).trim();
    const m = t.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    return parseBrDateTime(t);
}

function achaCampo(obj, padroes) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of Object.keys(obj)) {
          const kn = slug(k).replace(/ /g, '');
          if (padroes.some((p) => kn === p || kn.indexOf(p) !== -1)) {
                  const v = obj[k];
                  if (v !== null && v !== '' && typeof v !== 'object') return v;
          }
    }
    for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) {
                  const r = achaCampo(v, padroes);
                  if (r !== undefined) return r;
          }
    }
    return undefined;
}

function temperaturasDe(obj) {
    const t = [];
    for (let i = 1; i <= 3; i++) {
          const v = achaCampo(obj, ['s' + i + 'temp', 'temp' + i, 'temperatura' + i, 'sensor' + i]);
          const n = Number(String(v).replace(',', '.'));
          if (v !== undefined && !isNaN(n)) t.push(Math.round(n));
    }
    if (!t.length) {
          const v = achaCampo(obj, ['temperatura', 'temp']);
          const n = Number(String(v).replace(',', '.'));
          if (v !== undefined && !isNaN(n)) t.push(Math.round(n));
    }
    return t;
}

function mapearVeiculo(o) {
    if (!o) return null;
    const placa = o.placa || achaCampo(o, ['placa', 'veiculoplaca', 'placaveiculo']);
    if (!placa) return null;
    const temps = [];
    ['st1', 'st2', 'st3'].forEach((k) => {
          const v = o[k];
          if (v === null || v === undefined || v === '') return;
          const n = parseFloat(String(v).replace(',', '.').replace(/[^0-9.,-]/g, ''));
          if (!isNaN(n)) temps.push(Math.round(n));
    });
    if (!temps.length) temperaturasDe(o).forEach((t) => temps.push(t));
    const vel = Number(o.velocidade !== null ? o.velocidade : achaCampo(o, ['velocidade', 'kmh', 'vel'])) || 0;
    const pos = o.posicao !== null ? o.posicao : achaCampo(o, ['endereco', 'posicao', 'logradouro', 'local']);
    const ref = o.referencia !== null ? o.referencia : achaCampo(o, ['referencia', 'pontoreferencia', 'ponto']);
    const dh = o.datahora !== null ? o.datahora : achaCampo(o, ['datahora', 'dtposicao', 'data', 'dh']);
    return {
          placa: normalizePlaca(placa),
          motorista: o.motorista || '',
          tracking: {
                  posicao: pos ? String(pos) : '',
                  referencia: ref ? String(ref) : '',
                  velocidade: Math.round(vel),
                  temps: temps,
                  trackedAt: parseQualquerData(dh) || Date.now(),
          },
    };
}

function listaDaResposta(result) {
    if (Array.isArray(result)) return result;
    if (result && typeof result === 'object') {
          for (const k of Object.keys(result)) {
                  if (Array.isArray(result[k]) && result[k].length && typeof result[k][0] === 'object') return result[k];
          }
    }
    return [];
}

async function apiPost(rota, corpo, token) {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(API_BASE + rota, {
          method: 'POST', headers: h, body: JSON.stringify(corpo || {}),
          signal: AbortSignal.timeout(20000),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { /* resposta sem corpo JSON */ }
    return { http: r.status, body: j };
}

async function apiLogin(usuario, senha) {
    const r = await apiPost('/usuario/login', { usuario, senha });
    const res = r.body && r.body.result;
    if (r.body && r.body.status && res) {
          if (typeof res === 'string') return res;
          const t = res.token || res.jwt || res.access_token || res.accessToken;
          if (t) return String(t);
    }
    const msg = (typeof res === 'string' ? res : null) ||
          (r.body && (r.body.mensagem || r.body.message || r.body.erro)) ||
          ('HTTP ' + r.http);
    throw new Error('LOGIN: ' + msg);
}

async function apiFrota(token) {
    const r = await apiPost('/rastreamento/listar', { tipo: 'desktop' }, token);
    if (r.http === 401) throw new Error('401');
    if (r.body && r.body.result != null) return r.body.result;
    if (Array.isArray(r.body)) return r.body;
    throw new Error("Resposta sem 'result' (HTTP " + r.http + ')');
}

async function buscarFrotaMapeada() {
    let token = await apiLogin(CA2_USUARIO, CA2_SENHA);
    let result;
    try {
          result = await apiFrota(token);
    } catch (e) {
          if (String(e.message) === '401') {
                  token = await apiLogin(CA2_USUARIO, CA2_SENHA);
                  result = await apiFrota(token);
          } else throw e;
    }
    const lista = listaDaResposta(result);
    return lista.map(mapearVeiculo).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Supabase (mesmo padrao de CAS ja usado por sync-status-bsoft.js/anexar-nf.js)
// ---------------------------------------------------------------------------

function sbHeaders(extra) {
    return Object.assign(
      { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
          extra || {},
        );
}

async function lerLinhaUmaVez() {
      const url = SUPABASE_URL + '/rest/v1/painel?id=eq.' + encodeURIComponent(QUADRO) + '&select=dados,atualizado_em';
      const r = await fetch(url, { headers: sbHeaders(), signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('GET falhou: ' + r.status + ' ' + (await r.text()));
      const j = await r.json();
      if (!j[0]) throw new Error('Linha "' + QUADRO + '" nao existe no Supabase.');
      return j[0];
}

async function lerLinha(tentativas) {
      tentativas = tentativas || 6;
      console.log('robo-painel-motor: lendo quadro atual no Supabase...');
      let ultimoErro;
      for (let i = 0; i < tentativas; i++) {
                  try {
                              const linha = await lerLinhaUmaVez();
                              if (i > 0) console.log('robo-painel-motor: quadro lido com sucesso (tentativa ' + (i + 1) + '/' + tentativas + ').');
                              else console.log('robo-painel-motor: quadro lido com sucesso.');
                              return linha;
                  } catch (e) {
                              ultimoErro = e;
                              if (i === tentativas - 1) break;
                              const espera = Math.min(5000 * (i + 1), 30000);
                              console.log('robo-painel-motor: tentativa ' + (i + 1) + '/' + tentativas + ' de leitura falhou (' + (e && e.message ? e.message : e) + '), tentando de novo em ' + Math.round(espera / 1000) + 's...');
                              await new Promise((r) => setTimeout(r, espera));
                  }
      }
      throw ultimoErro;
}
async function gravarComCAS(mutar, tentativas) {
    tentativas = tentativas || 5;
    for (let i = 0; i < tentativas; i++) {
          const linha = await lerLinha();
          const dados = linha.dados;
          const resultado = mutar(dados);
          if (!resultado || resultado.pulou) return resultado || { pulou: true };
          if (DRY) {
                  console.log('[modo_seco] gravaria ' + JSON.stringify(dados).length + ' bytes, sem gravar de fato.');
                  console.log('[modo_seco] eventos: ' + (resultado.eventos || []).join(' | '));
                  return { ok: true, seco: true };
          }
          const url = SUPABASE_URL + '/rest/v1/painel?id=eq.' + encodeURIComponent(QUADRO) +
                  '&atualizado_em=eq.' + encodeURIComponent(linha.atualizado_em);
          const novoCarimbo = new Date().toISOString();
          console.log('robo-painel-motor: gravando no Supabase...');
          const r = await fetch(url, {
      method: 'PATCH',
                  headers: sbHeaders({ Prefer: 'return=representation' }),
                  body: JSON.stringify({ dados, por: 'robo-painel-motor', atualizado_em: novoCarimbo }),
                  signal: AbortSignal.timeout(60000),
          });
          if (!r.ok) throw new Error('PATCH falhou: ' + r.status + ' ' + (await r.text()));
          const arr = await r.json();
          if (arr.length) return { ok: true, eventos: resultado.eventos };
          console.log('Conflito de gravacao (tentativa ' + (i + 1) + '/' + tentativas + '), relendo...');
    }
    throw new Error('Nao consegui gravar apos ' + tentativas + ' tentativas (conflito repetido).');
}

// ---------------------------------------------------------------------------
// Motor: uma passada completa sobre o quadro
// ---------------------------------------------------------------------------

function formatarPlaca(p) {
    return (p && p.length === 7) ? (p.slice(0, 3) + '-' + p.slice(3)) : p;
}

function rodarMotor(dados, mapeados) {
    const eventos = [];
    const agora = Date.now();
    const drivers = dados.motoristas || (dados.motoristas = []);
    const arquivo = dados.historico || (dados.historico = []);
    dados.placasEncerradas = dados.placasEncerradas || {};

  const porPlaca = {};
    mapeados.forEach((m) => { porPlaca[m.placa] = m; });

  // 0) funde fichas duplicadas da mesma placa. Pode acontecer quando duas rotinas
  //    diferentes criam card pra mesma placa sem uma checar a outra primeiro --
  //    achado em 28/08/2026 na AVW-7J79: o cadastro feito a partir do e-mail de
  //    viagem nao conferia se ja existia ficha ATIVA daquela placa antes de criar
  //    outra. Este passo cura o quadro sozinho a cada ciclo (5 em 5 min), seja
  //    qual for a origem da duplicata, mantendo a ficha "mais rica" (com MDF-e
  //    e/ou entregas) e juntando o que a outra tinha de util antes de descartar.
  (function fundirDuplicadas() {
        const grupos = {};
        drivers.forEach((d) => {
                const p = normalizePlaca(d.placa);
                (grupos[p] || (grupos[p] = [])).push(d);
        });
        let houveFusao = false;
        const mantidos = [];
        Object.keys(grupos).forEach((p) => {
                const grupo = grupos[p];
                if (grupo.length <= 1) { mantidos.push(grupo[0]); return; }
                houveFusao = true;
                grupo.sort((a, b) => {
                          const ra = (a.mdfe ? 2 : 0) + (a.entregas && a.entregas.length ? 1 : 0);
                          const rb = (b.mdfe ? 2 : 0) + (b.entregas && b.entregas.length ? 1 : 0);
                          if (rb !== ra) return rb - ra;
                          return (b.updatedAt || 0) - (a.updatedAt || 0);
                });
                const principal = grupo[0];
                const vistos = new Set((principal.entregas || []).map(tKey));
                for (let i = 1; i < grupo.length; i++) {
                          const extra = grupo[i];
                          (extra.entregas || []).forEach((e) => {
                                      if (!vistos.has(tKey(e))) {
                                                    principal.entregas = principal.entregas || [];
                                                    principal.entregas.push(e);
                                                    vistos.add(tKey(e));
                                      }
                          });
                          if (extra.anexosEntrega) {
                                      principal.anexosEntrega = principal.anexosEntrega || {};
                                      Object.keys(extra.anexosEntrega).forEach((k) => {
                                                    principal.anexosEntrega[k] = (principal.anexosEntrega[k] || []).concat(extra.anexosEntrega[k]);
                                      });
                          }
                          if (!principal.tracking && extra.tracking) principal.tracking = extra.tracking;
                          if (!principal.mdfe && extra.mdfe) principal.mdfe = extra.mdfe;
                          if (!principal.problema && extra.problema) principal.problema = extra.problema;
                }
                principal.updatedAt = agora + 60000;
                mantidos.push(principal);
                eventos.push(formatarPlaca(p) + ': ' + grupo.length + ' fichas ativas duplicadas encontradas e mescladas em uma');
        });
        if (houveFusao) {
                drivers.length = 0;
                mantidos.forEach((d) => drivers.push(d));
        }
  })();

  // 1) tracking dos ja existentes -- pula finalizado de proposito (ver nota no
  //    topo do arquivo: bumpar updatedAt de um finalizado atrasaria o
  //    arquivamento do passo 7 para sempre, enquanto o GPS continuar transmitindo).
  drivers.forEach((d) => {
        if (d.status === 'finalizado') return;
        const m = porPlaca[normalizePlaca(d.placa)];
        if (m) {
                const antes = JSON.stringify(d.tracking || null);
                const depois = JSON.stringify(m.tracking);
                if (antes !== depois) {
                          d.tracking = m.tracking;
                          d.updatedAt = agora + 60000;
                          eventos.push(d.placa + ': posicao atualizada');
                }
        }
  });

  // 2) espelhamento -- so cria card pra placa NUNCA vista (nem ativa, nem
  //    arquivada, nem recem-encerrada por este robo). Mesma regra do
  //    PATCH_ESPELHAMENTO v3 do navegador (ver index.html): nunca ressuscita uma
  //    placa ja encerrada sozinho, so o ciclo BSoft faz isso de proposito.
  //
  //    FIX (28/08/2026) -- causa raiz do loop MIZ-0858/QAW-1E78: desde que o
  //    passo 6 parou de mover finalizado pra dados.historico (commit "Stop
  //    archiving finished trips into historico", pra nao lotar o Supabase de
  //    novo), o "noArquivo" abaixo nunca mais achava nada pra placa nenhuma --
  //    entao qualquer caminhao com o rastreio ainda transmitindo (comum com o
  //    veiculo parado no patio/oficina, motorista desliga e liga de novo)
  //    ressuscitava sozinho minutos depois de ter sido removido, o robo de
  //    BSoft/e-mail marcava "sem NF" de novo (porque de fato nao ha viagem
  //    nenhuma), e o card voltava a ser removido daqui a pouco -- loop.
  //    dados.placasEncerradas cobre esse buraco sem reintroduzir o problema de
  //    espaco: guarda so placa + quando foi removida (nao a ficha inteira), e e
  //    podado com mais de 90 dias no passo 6.
  const novos = [];
    Object.keys(porPlaca).forEach((p) => {
          const noQuadro = drivers.some((d) => normalizePlaca(d.placa) === p);
          if (noQuadro) return;
          const noArquivo = arquivo.some((d) => normalizePlaca(d.placa) === p);
          if (noArquivo) return;
          if (dados.placasEncerradas[p]) return;
          novos.push(porPlaca[p]);
    });
    novos.forEach((m) => {
          drivers.unshift({
                  id: 'd-' + agora + '-' + Math.floor(Math.random() * 1000),
                  motorista: (m.motorista || '').toUpperCase(),
                  placa: formatarPlaca(m.placa),
                  mdfe: '',
                  status: 'carregando',
                  problema: false,
                  obs: 'criado automatico pelo robo de rastreio na nuvem - aguardando BSoft',
                  updatedAt: agora,
                  tracking: m.tracking || null,
                  entregas: [],
                  semNf: false,
                  bsoftAberto: false,
          });
          eventos.push(m.placa + ': placa nova no rastreio, card criado (aguardando BSoft)');
    });

  // 3) conclusao automatica de entrega por proximidade (mirror de processarEntregas)
  //    pula finalizado pelo mesmo motivo do passo 1: nao pode bumpar updatedAt de
  //    quem ja esta parado nesse estado, ou o arquivamento do passo 6 nunca dispara.
  drivers.forEach((d) => {
        if (d.status === 'finalizado') return;
        const t = d.tracking;
        if (!t || !t.trackedAt) return;
        const ref = t.referencia || t.posicao || '';
        const dist = distanciaRefMetros(ref);
        const vel = Number(t.velocidade || 0);
        const dentro = dist !== null && dist <= RAIO_CLIENTE_M && vel <= VEL_PARADO_KMH;
        const idx = casarEntrega(ref, d.entregas);
        if (dentro && idx >= 0) {
                const e = d.entregas[idx];
                if (!e._chegouEm) {
                          e._chegouEm = Number(t.trackedAt);
                          d.updatedAt = agora + 60000;
                          eventos.push(d.placa + ': chegou em ' + e.cliente);
                }
        }
        /* REMOVIDO (31/08/2026) - pedido do dono ("tira essa regra pf", ver claude/pendencias-e-descobertas.md):
           a confirmacao automatica de entrega so por tempo parado foi desativada tambem aqui no robo da nuvem
           (o navegador ja tinha sido corrigido em 31/08 via PATCH_REMOVE_ENTREGA_AUTO_CONFIRMA v1, mas esse
           script roda separado e ainda tinha a mesma regra ativa). O caminhao pode ficar parado no cliente so
           esperando fila pra descarregar, nao significa que a entrega terminou de verdade. A deteccao de
           chegada (_chegouEm, acima) continua ativa - so a confirmacao automatica da entrega foi desligada.
           Confirmacao de entrega agora e so manual, pelo escritorio ou pelo link do motorista.
           Bloco original abaixo, comentado so pra referencia caso precise reativar um dia: */
        // (d.entregas || []).forEach((e) => {
        //         if (e.concluida || !e._chegouEm) return;
        //         const parado = (agora - e._chegouEm) / 60000;
        //         if (parado >= ENTREGA_MIN_MINUTOS && emHorarioUtil(e._chegouEm)) {
        //                   e.concluida = true;
        //                   e._auto = true;
        //                   e._concluidaEm = agora;
        //                   d.updatedAt = agora + 60000;
        //                   eventos.push(d.placa + ': entrega concluida automaticamente: ' + e.cliente);
        //         }
        // });
        const ents = d.entregas || [];
        const novoOk = !!(ents.length && ents.every((e) => e.concluida));
        if (d._entregasOk !== novoOk) { d._entregasOk = novoOk; d.updatedAt = agora + 60000; }
  });

  // 4) tempo parado por cliente (mirror de __tickTempos) -- mesma ressalva do
  //    passo 3, pula finalizado pra nao atrasar o arquivamento do passo 6.
  drivers.forEach((d) => {
        if (d.status === 'finalizado') return;
        let i = -1;
        try { i = entregaNaReferencia(d); } catch (e) { /* posicao/entregas mal formadas, ignora */ }
        const atKey = (i >= 0 && d.entregas && d.entregas[i]) ? tKey(d.entregas[i]) : null;
        d.tempos = d.tempos || {};
        let mudouLocal = false;
        Object.keys(d.tempos).forEach((k) => {
                if (k !== atKey && d.tempos[k] && d.tempos[k].desde) {
                          d.tempos[k].total = (d.tempos[k].total || 0) + (agora - d.tempos[k].desde);
                          d.tempos[k].desde = null;
                          mudouLocal = true;
                }
        });
        if (atKey) {
                if (!d.tempos[atKey]) { d.tempos[atKey] = { total: 0, desde: agora }; mudouLocal = true; }
                else if (!d.tempos[atKey].desde) { d.tempos[atKey].desde = agora; mudouLocal = true; }
        }
        if (mudouLocal) d.updatedAt = agora + 60000;
  });

  // 5) status automatico
  drivers.forEach((d) => {
        const novo = statusAutomatico(d);
        if (novo !== d.status) {
                eventos.push(d.placa + ': status ' + d.status + ' -> ' + novo);
                d.status = novo;
                d.updatedAt = agora + 60000;
        }
  });

  // 6) apagar finalizado ha 5+ min (pedido do dono 27/08/2026: BSoft ja guarda a NF/viagem,
  // entao o Painel nao precisa mais reter nada depois de finalizar - so remove do quadro
  // ativo, nao move mais para o historico. dados.fotos e qualquer contato nao sao tocados.)
  // Antes de remover, registra a placa em dados.placasEncerradas (ver nota do passo 2) --
  // e o que impede o proprio robo de recriar essa ficha sozinho minutos depois.
  const permanecem = [];
    drivers.forEach((d) => {
          if (d.status === 'finalizado' && d.updatedAt && (agora - d.updatedAt) >= ARQUIVA_APOS_MS) {
                  dados.placasEncerradas[normalizePlaca(d.placa)] = agora;
                  eventos.push(d.placa + ': removida do painel (finalizada ha 5+ min, dados ja estao no BSoft)');
          } else {
                  permanecem.push(d);
          }
    });

  dados.motoristas = permanecem;

  // poda dados.placasEncerradas com mais de 90 dias -- o objetivo e so cobrir a
  // janela em que o GPS pode continuar transmitindo depois do fim da viagem
  // (caminhao no patio), nao virar um historico completo de novo.
  const LIMITE_PODA_MS = 90 * 24 * 3600 * 1000;
    Object.keys(dados.placasEncerradas).forEach((p) => {
          if (agora - dados.placasEncerradas[p] > LIMITE_PODA_MS) delete dados.placasEncerradas[p];
    });

  return eventos;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
    console.log('robo-painel-motor: buscando frota no Ca2Track...');
    const mapeados = await buscarFrotaMapeada();
    console.log('robo-painel-motor: ' + mapeados.length + ' veiculo(s) recebido(s) do Ca2Track.');

  const resultado = await gravarComCAS((dados) => {
        const eventos = rodarMotor(dados, mapeados);
      if (!eventos.length) return { pulou: true };
        return { eventos };
  });

  if (resultado.pulou) {
        console.log('Nada mudou neste ciclo.');
        return;
  }
    if (resultado.seco) {
          console.log('[modo_seco] simulacao concluida, nada foi gravado de verdade.');
          return;
    }
    console.log('Gravado com sucesso. Eventos deste ciclo:');
    (resultado.eventos || []).forEach((e) => console.log('  - ' + e));
}

main().catch((e) => {
    console.error('ERRO:', e && e.message ? e.message : e);
    process.exit(1);
});
