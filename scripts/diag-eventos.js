#!/usr/bin/env node
'use strict';

// diag-eventos v2: script DE USO UNICO (descartavel) -- ja confirmou que existe
// evento de porta do bau via /evento_historico/analitico (cod_tipoevento 99 =
// "Porta do Bau Aberta 1 (sensor)"). Agora busca, pra TODA a frota, os ultimos
// 14 dias de eventos, monta um dicionario tipoevento->cod_tipoevento, e lista
// especificamente os eventos de porta (motorista/carona/bau) com data/hora, pra
// confirmar o par abertura/fechamento. So loga no console, nao grava nada.
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

async function main() {
    console.log('=== diag-eventos v2: login ===');
    const token = await login();
    console.log('Login OK.');

    const frota = await apiPost('/rastreamento/listar', { tipo: 'desktop' }, token);
    let lista = [];
    if (frota.body && frota.body.result) {
        lista = Array.isArray(frota.body.result) ? frota.body.result
            : (Object.values(frota.body.result).find((v) => Array.isArray(v)) || []);
    }
    console.log('Veiculos:', lista.map((v) => v.placa + '(cod ' + v.cod_veiculo + ')').join(', '));

    const agora = new Date();
    const catorzeDias = new Date(agora.getTime() - 14 * 24 * 60 * 60 * 1000);
    const di = catorzeDias.toISOString(), df = agora.toISOString();

    const legenda = {};
    const eventosPorta = [];

    for (const v of lista) {
        const r = await apiPost('/evento_historico/analitico', { cod_veiculo: v.cod_veiculo, di, df }, token);
        const eventos = (r.body && r.body.result) || [];
        console.log(v.placa + ': ' + eventos.length + ' eventos em 14 dias');
        eventos.forEach((e) => {
            legenda[e.cod_tipoevento] = e.tipoevento;
            if (/porta|ba.?u|sensor/i.test(e.tipoevento || '')) {
                eventosPorta.push({ placa: v.placa, tipo: e.tipoevento, cod: e.cod_tipoevento, quando: e.ins_data, pos: e.posicao });
            }
        });
    }

    console.log('\n=== LEGENDA cod_tipoevento -> tipoevento (todos os tipos vistos) ===');
    Object.keys(legenda).sort((a, b) => Number(a) - Number(b)).forEach((k) => {
        console.log(k + ': ' + legenda[k]);
    });

    console.log('\n=== EVENTOS DE PORTA/BAU/SENSOR (todos os veiculos, 14 dias, ordenados) ===');
    eventosPorta.sort((a, b) => String(a.quando).localeCompare(String(b.quando)));
    eventosPorta.forEach((e) => {
        console.log(e.quando + ' | ' + e.placa + ' | cod ' + e.cod + ' | ' + e.tipo + ' | ' + e.pos);
    });
    console.log('\nTotal eventos de porta/bau encontrados:', eventosPorta.length);

    console.log('\n=== FIM diag-eventos v2 ===');
}

main().catch((e) => { console.error('Falha geral:', e.message); process.exit(1); });
