#!/usr/bin/env node
'use strict';

// diag-eventos: script DE USO ÚNICO (descartável) para descobrir se a API do
// Ca2Track expõe evento de abertura/fechamento de porta do baú, via os
// endpoints /evento_historico/analitico e /ocorrencia_historico/analitico
// (citados no manual mas nunca testados). Não grava nada em lugar nenhum --
// só loga no console do GitHub Actions. Roda só via workflow_dispatch.
//
// Este script nunca deve imprimir os segredos (CA2_USUARIO/CA2_SENHA).

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

function pad(s) { return JSON.stringify(s, null, 1); }

function dataBR(d) {
    const p2 = (n) => String(n).padStart(2, '0');
    return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' +
        p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}
function dataISO(d) { return d.toISOString(); }

async function main() {
    console.log('=== diag-eventos: login ===');
    const token = await login();
    console.log('Login OK, token recebido (' + token.length + ' chars).');

    console.log('\n=== diag-eventos: /rastreamento/listar (achar 1 veiculo de amostra) ===');
    const frota = await apiPost('/rastreamento/listar', { tipo: 'desktop' }, token);
    console.log('HTTP', frota.http);
    let lista = [];
    if (frota.body && frota.body.result) {
        lista = Array.isArray(frota.body.result) ? frota.body.result
            : (Object.values(frota.body.result).find((v) => Array.isArray(v)) || []);
    }
    console.log('Veiculos recebidos:', lista.length);
    if (!lista.length) { console.log('Nada recebido, abortando.'); return; }
    const amostra = lista[0];
    console.log('Campos do 1o veiculo (chaves):', Object.keys(amostra));
    console.log('1o veiculo completo:', pad(amostra));

    // candidatos a campo de identificador do veiculo, pra usar nos endpoints de historico
    const idCandidatos = ['cod_veiculo', 'codveiculo', 'codVeiculo', 'idveiculo', 'idVeiculo',
        'id_veiculo', 'veiculo_id', 'veiculoId', 'cod_rastreador', 'codRastreador', 'id'];
    const idsAchados = {};
    idCandidatos.forEach((k) => { if (amostra[k] !== undefined) idsAchados[k] = amostra[k]; });
    console.log('Possiveis campos de ID encontrados na amostra:', pad(idsAchados));

    const agora = new Date();
    const seteDiasAtras = new Date(agora.getTime() - 7 * 24 * 60 * 60 * 1000);
    const diBR = dataBR(seteDiasAtras), dfBR = dataBR(agora);
    const diISO = dataISO(seteDiasAtras), dfISO = dataISO(agora);

    const idParaTeste = Object.values(idsAchados)[0];

    const corposParaTestar = [
        { rota: '/evento_historico/analitico', nome: 'evento (BR date, cod_veiculo)', corpo: { cod_veiculo: idParaTeste, di: diBR, df: dfBR } },
        { rota: '/evento_historico/analitico', nome: 'evento (ISO date, cod_veiculo)', corpo: { cod_veiculo: idParaTeste, di: diISO, df: dfISO } },
        { rota: '/evento_historico/analitico', nome: 'evento (BR date, sem veiculo = frota toda)', corpo: { tipo: 'desktop', di: diBR, df: dfBR } },
        { rota: '/ocorrencia_historico/analitico', nome: 'ocorrencia (BR date, cod_veiculo)', corpo: { cod_veiculo: idParaTeste, di: diBR, df: dfBR } },
        { rota: '/ocorrencia_historico/analitico', nome: 'ocorrencia (ISO date, cod_veiculo)', corpo: { cod_veiculo: idParaTeste, di: diISO, df: dfISO } },
        { rota: '/ocorrencia_historico/analitico', nome: 'ocorrencia (BR date, sem veiculo = frota toda)', corpo: { tipo: 'desktop', di: diBR, df: dfBR } },
    ];

    for (const t of corposParaTestar) {
        console.log('\n=== ' + t.nome + ' -> POST ' + t.rota + ' ' + pad(t.corpo) + ' ===');
        try {
            const r = await apiPost(t.rota, t.corpo, token);
            console.log('HTTP', r.http);
            const s = pad(r.body);
            console.log('Resposta (ate 3000 chars):', s.length > 3000 ? s.slice(0, 3000) + '...' : s);
        } catch (e) {
            console.log('Erro:', e.message);
        }
    }

    console.log('\n=== FIM diag-eventos ===');
}

main().catch((e) => { console.error('Falha geral:', e.message); process.exit(1); });
