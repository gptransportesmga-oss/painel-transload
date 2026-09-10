#!/usr/bin/env node
'use strict';

// diag-eventos v3: script DE USO UNICO (descartavel). Ja confirmado nas v1/v2:
// - evento "Porta do Bau Aberta 1 (sensor)" (cod_tipoevento 99) existe via
//   /evento_historico/analitico, mas NAO existe um tipo de evento "fechada" na
//   legenda inteira (17 tipos vistos em 3297 eventos / 8 veiculos / 14 dias).
// - o objeto de /rastreamento/listar de cada veiculo tem um campo "evt_099"
//   (S/N) -- hipotese: e um flag de estado ATUAL (aberta agora = S), o que
//   permitiria inferir o fechamento (quando volta pra N), mesmo sem um evento
//   discreto de "fechou". Este script testa essa hipotese: pra cada veiculo,
//   compara evt_099 atual com o horario do ultimo evento cod 99 no historico.
//
// So loga no console, nao grava nada. Nunca imprime os segredos.

const CA2_USUARIO = process.env.CA2_USUARIO;
const CA2_SENHA = process.env.CA2_SENHA;

if (!CA2_USUARIO || !CA2_SENHA) {
    console.error('Faltam segredos: CA2_USUARIO / CA2_SENHA.');
    process.exit(1);
}

const API_BASE = 'https://ca2soft.com.br/itransrisco';

async function apiPost(rota, corpo, token) {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(API_BASE + rota, {
        method: 'POST', headers: h, body: JSON.stringify(corpo || {}),
        signal: AbortSignal.timeout(20000),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { /* sem corpo JSON */ }
    return { http: r.status, body: j };
}

async function login() {
    const r = await apiPost('/usuario/login', { usuario: CA2_USUARIO, senha: CA2_SENHA });
    const res = r.body && r.body.result;
    if (r.body && r.body.status && res) {
        if (typeof res === 'string') return res;
        const t = res.token || res.jwt || res.access_token || res.accessToken;
        if (t) return String(t);
    }
    throw new Error('LOGIN falhou: HTTP ' + r.http + ' ' + JSON.stringify(r.body));
}

async function main() {
    const token = await login();
    console.log('Login OK.\n');

    const frota = await apiPost('/rastreamento/listar', { tipo: 'desktop' }, token);
    let lista = [];
    if (frota.body && frota.body.result) {
        lista = Array.isArray(frota.body.result) ? frota.body.result
            : (Object.values(frota.body.result).find((v) => Array.isArray(v)) || []);
    }

    const agora = new Date();
    const doisDias = new Date(agora.getTime() - 2 * 24 * 60 * 60 * 1000);
    const di = doisDias.toISOString(), df = agora.toISOString();

    console.log('placa | evt_099 (flag atual) | datahora do rastreio | ultimos eventos cod 99 (abertura) nas ultimas 48h');
    console.log('---');
    for (const v of lista) {
        const r = await apiPost('/evento_historico/analitico', { cod_veiculo: v.cod_veiculo, di, df }, token);
        const eventos = ((r.body && r.body.result) || []).filter((e) => e.cod_tipoevento === 99);
        const ultimos = eventos.slice(-3).map((e) => e.ins_data).join(' | ') || '(nenhum nas ultimas 48h)';
        console.log(v.placa + ' | evt_099=' + v.evt_099 + ' | rastreio ' + v.datahora + ' | ' + ultimos);
    }

    console.log('\n=== FIM diag-eventos v3 ===');
}

main().catch((e) => { console.error('Falha geral:', e.message); process.exit(1); });
