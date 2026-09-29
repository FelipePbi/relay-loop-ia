# Relay Loop IA

**Relay Loop IA** é um orquestrador autônomo de agentes de IA para automação de
projetos de engenharia de software. Ele conduz um Goal (uma etapa de trabalho)
do início ao fim: implementação, revisão, correções, aceite e fechamento. Só
para quando uma condição realmente exige uma pessoa. Coordena dois papéis de
agente (um Tech Lead que planeja e revisa, um Developer que implementa) sobre um
protocolo próprio de jobs, leases e worktrees em disco, com recuperação de
falhas, roteamento adaptativo de modelo e telemetria de custo desde a primeira
chamada.

**Em números** (ledger real de uso, mais de 70 Goals):

- **52%** das unidades de trabalho resolvidas em código, sem chamar modelo
- **32,6%** a menos de custo equivalente de API com o roteamento adaptativo,
  contra usar Opus em tudo
- **1.617** testes automatizados, nenhum com chamada real a modelo

**Stack:** Node.js ≥ 20, JavaScript ESM, zero dependências de runtime (só
builtins do Node), SQLite nativo (`node:sqlite`) para telemetria. Os agentes são
executados pelo Claude Code CLI.

**Autor:** Felipe Borges ·
[LinkedIn](https://www.linkedin.com/in/felipe-borges-pbi) ·

## Origem

O Relay Loop IA nasceu em `tools/ia-loop/` dentro do monorepo `atendly-ia`. O
Atendly começou como uma ferramenta de atendimento via WhatsApp para uso
pessoal. Depois que ela provou funcionar, a decisão foi transformá-la em um
produto multi-tenant para outros profissionais autônomos. Essa migração, de
todo o legado para um produto novo, é conduzida pelo Relay Loop IA em dezenas
de Goals sequenciais.

Este repositório é a versão standalone, extraída em 2026-09-19: mesmo motor,
para ser usado em outros projetos e domínios.

## Por que existe

Migrações e refatorações grandes costumam ser quebradas em etapas (aqui
chamadas de **Goals**) que um humano então acompanha uma a uma: escrever a
tarefa, esperar a implementação, revisar, pedir correção, aceitar, fechar,
escrever a próxima. O Relay Loop IA automatiza esse ciclo inteiro, com dois
objetivos que orientam toda a arquitetura:

- **Rodar sozinho de verdade.** O loop autônomo (`ia-loop:auto`) encadeia
  Goal após Goal e só para por um motivo real: uma condição que exige uma
  pessoa, uma pausa pedida explicitamente, ou o trabalho declarado completo.
- **Gastar o mínimo necessário com modelo.** Cada unidade de trabalho é
  roteada para o modelo mais barato capaz de resolvê-la, ou para nenhum
  modelo, quando a tarefa é determinística e pode ser resolvida em código.

## Como funciona

```
Goal (READY) → Developer implementa → Tech Lead revisa
     ↑                                        │
     │                              CHANGES_REQUIRED
     │                                        │
     └──────────── Correction round ──────────┘
                                               │
                                          ACCEPTED
                                               │
                                    Closure (docs + commit)
                                               │
                                     Planeja o próximo Goal
                                               │
                                          (repete)
```

- **Dois papéis, dois perfis de execução.** O **Tech Lead** roda em sessão
  persistente e é responsável por planejar e revisar. O **Developer** roda como
  processo stateless por rodada e é responsável por implementar.
- **Roteamento adaptativo de modelo.** Cada Work Unit é classificada por
  natureza e complexidade. Unidades determinísticas (typecheck, lint, testes de
  integração) nunca chamam modelo. Para as que precisam de modelo, o Developer
  começa sempre no perfil `SONNET_HIGH` e só escala para Opus com evidência: o
  Tech Lead pediu escalação na revisão, ou o próprio Developer pediu durante a
  rodada. Uma rodada de correção sem escalação mantém o perfil anterior; o
  número da rodada, sozinho, nunca muda o modelo.
- **Protocolo em arquivo, não em banco.** Jobs, leases, resultados e o estado
  da run autônoma vivem em `.state/` como JSON/JSONL com escrita atômica
  (arquivo temporário + rename). Não há dependência de um banco externo para
  o protocolo em si, só uma ledger opcional em SQLite para telemetria de uso.
- **Cada etapa roda isolada em um worktree git próprio**, para que o trabalho
  em andamento nunca colida com o branch principal nem com outra etapa
  concorrente.
- **Leases em vez de locks ingênuos.** Um job é reivindicado atomicamente;
  uma lease só declara um worker morto depois de evidência comprovada
  (heartbeat expirado e processo comprovadamente ausente), nunca por hábito.
- **Recuperação depois de um crash ou reboot** é um comando dedicado
  (`ia-loop:recover`), separado da retomada depois de um limite de uso
  (`ia-loop:resume`): são duas situações diferentes e pedem respostas
  diferentes.
- **Gate humano por política.** Um Goal pausa com `humanRequired` em caso de
  violação de política ou falha de capacidade, e só volta a andar depois de
  resolvido explicitamente. Fora isso, o ciclo planeja, desenvolve, revisa e
  fecha sem aprovação humana.
- **Telemetria de custo desde a primeira chamada.** Toda execução de modelo
  vira uma linha no ledger de uso: tokens, custo reportado pelo provider,
  modelo servido de fato (nunca assumido), o suficiente para comparar
  cenários (`ALL_OPUS` hipotético, por exemplo) contra o que realmente
  aconteceu.

Cada uma dessas decisões de design tem sua motivação registrada em detalhe no
[log de engenharia](docs/ENGINEERING_LOG.md) (30 versões, V1 a V30).

## Resultados de uso real (monorepo atendly-ia)

Números abaixo vêm do ledger real de uso no projeto de origem (`atendly-ia`),
extraídos via `run-metrics.mjs` sobre mais de **70 Goals** já concluídos.
Não são projeção nem simulação. Cobertura de custo do provider: 99,6%.

**Sobre os valores em dólar:** o Relay Loop IA executa os agentes pelo Claude
Code CLI, não por chamada direta de API. Os valores abaixo são o **custo
equivalente de API** reportado pelo provider, não gasto efetivo. As comparações
percentuais valem do mesmo jeito, porque os dois lados usam a mesma tabela de
preços.

### Roteamento determinístico vs. LLM

| Métrica | Valor |
| --- | --- |
| Work Units no ledger | 2.389 |
| Resolvidas em código (sem modelo) | 1.242 (52%) |
| Resolvidas por LLM | 1.147 (48%) |

### Economia de custo equivalente

**Medido:**

| Camada | Como funciona | Economia |
| --- | --- | --- |
| Roteamento de modelo | Custo equivalente de $3.318,41 vs. baseline hipotético "tudo em Opus" de $4.923,11 | **$1.604,70 (32,6%)** |

Quase toda a economia de roteamento vem do Sonnet ($1.566,99). O Fable, quando
usado, custou $152,71 a mais que o Opus, não menos.

**Estimado (confiança baixa, não é medição direta):**

| Camada | Como funciona | Economia estimada |
| --- | --- | --- |
| Desvio para execução determinística | ~1.242 chamadas de modelo evitadas (confiança LOW, n=589) | $1.178,67 a $5.175,93 (central $2.511,37) |
| Total combinado (ESTIMATED) | Soma da camada medida com a estimada | $2.783,37 a $6.780,63 (central $4.116,07) |

### Custo equivalente por unidade de trabalho

| Métrica | Valor |
| --- | --- |
| Custo médio por Work Unit bem-sucedida | ~$3,33 |
| Custo médio por Goal | ~$51 |
| Mediana por Goal | $42 |
| Mínimo por Goal | $3,42 |
| Máximo por Goal | $198,66 |
| Goals com custo registrado | 64 (soma $3.281,34) |

### Fallback e escalação entre modelos

São raros e sempre por motivo técnico explícito, nunca por "o modelo travou"
ou falha de qualidade.

| Nível | Total | Com fallback/escalação | % |
| --- | --- | --- | --- |
| Chamadas de modelo | 1.147 | 32 | 2,8% |
| Jobs | 1.041 | 31 | 3,0% |

| Tipo | Motivo | Ocorrências |
| --- | --- | --- |
| Fallback | `USAGE_LIMIT` | 10 |
| Escalação | `TOOLING_PERMISSION_DENIED` | 13 |
| Escalação | `PLAN_INCOMPATIBILITY` | 6 |
| Escalação | `COMPLEXITY_DISCOVERED` | 2 |
| Escalação | `REVIEW_INCONCLUSIVE` | 1 |

| Grupo de jobs | Taxa de conclusão |
| --- | --- |
| Com fallback/escalação | 93,5% |
| Sem fallback/escalação | 98,7% |

A tarefa quase sempre termina depois do fallback, mas a taxa de conclusão cai
cerca de 5 pontos.

### Achado que corrigiu o próprio roteamento (V28)

O Fable não era roteamento adaptativo: era taxa fixa disfarçada. Todo Goal
caía nele por uma regra de segurança (regex `tenant|session|auth`) que batia
em praticamente qualquer arquivo do projeto de origem. Nos últimos 10 Goals
executados depois da correção, o roteamento real é Opus e Sonnet em quase todo
Goal, Haiku aparecendo uma única vez, e **zero** Fable.

### Custo cresce de forma quadrática com os turnos

O ledger mostrou que o consumo de uma sessão cresce de forma quadrática com o
número de turnos: tokens(n) ≈ 29k·n + 872·n². Por isso o motivo principal para
decompor um Goal em Work Units é resetar o contexto, e não só escolher o
modelo.

## Requisitos

- **Node.js ≥ 20**
- **CLI do Claude Code** instalado e autenticado no host, visível no `PATH`
  (ou apontado via `IA_LOOP_CLAUDE_BIN`). É ele quem efetivamente invoca os
  agentes. O Relay Loop IA não fala com nenhuma API de modelo diretamente.

## Instalação

```bash
npm install
```

Não há dependências de terceiros em runtime, só Node builtins. `npm install`
existe para gerar o `package-lock.json` e deixar o projeto num estado
reprodutível.

## Uso

```bash
npm test                          # 1617 testes locais, sem chamada real a modelo
```

```bash
npm run ia-loop:status            # lê o estado persistido em .state/; não chama modelo
```

```bash
npm run ia-loop:goal -- 003 --dry-run   # inspeciona um Goal sem publicar job nem chamar modelo
```

```bash
npm run ia-loop:auto -- --from 003      # roda Goals em sequência até uma parada real
```

```bash
npm run ia-loop:pause                   # pede parada na próxima fronteira segura
```

```bash
npm run ia-loop:recover                 # retoma uma execução interrompida por crash ou reboot
```

```bash
npm run ia-loop:resume                  # retoma uma etapa parada por limite de uso da API
```

A lista completa dos ~20 comandos `ia-loop:*` está em [package.json](package.json);
o papel de cada um está documentado na seção "Como executar" do
[log de engenharia](docs/ENGINEERING_LOG.md).

### Variáveis de ambiente

| Variável | Efeito |
| --- | --- |
| `IA_LOOP_CLAUDE_BIN` | Caminho explícito do executável do Claude Code CLI |
| `IA_LOOP_TECH_LEAD_MODEL` | Modelo do Tech Lead (padrão no código: `claude-fable-5-1`; recomendado: `claude-opus-5`, veja abaixo) |
| `IA_LOOP_DEVELOPER_MODEL` | Modelo do Developer (padrão `claude-opus-5`; o roteamento adaptativo começa em `SONNET_HIGH`) |
| `IA_LOOP_TIMEOUT_MS` | Timeout por processo de agente |

**Sobre o modelo do Tech Lead:** o Fable foi o padrão inicial, mas o ledger
mostrou que ele custava mais que o Opus sem entregar valor proporcional. A
recomendação é definir `IA_LOOP_TECH_LEAD_MODEL=claude-opus-5`.

Nenhuma saída do harness imprime prompt completo, token, credencial, session
id ou dado pessoal.

## Estrutura do projeto

```
run-*.mjs        Scripts de entrada (um por comando ia-loop:*)
workers/         tech-lead.mjs e developer.mjs: os dois processos de agente
lib/             Núcleo: state machine, leases, jobs, roteamento, telemetria,
                 git ops, worktrees, capacidade/uso, recuperação
tests/           1617 testes (node:test), tudo com processo/agente fake
fixtures/        Dados sintéticos usados pelos testes
.state/          Estado runtime (git-ignorado); snapshot inicial preservado
                 no histórico do git a partir do repositório de origem
docs/            Log de engenharia detalhado (histórico versão a versão)
```

## Estado atual e limitações conhecidas

Este repositório nasceu como uma extração-cópia do `tools/ia-loop/` original
(2026-09-19). Duas coisas ainda carregam a forma do projeto onde nasceu:

- **Fluxo de Goals ainda não é genérico.** Os comandos `ia-loop:auto`,
  `ia-loop:goal`, `ia-loop:close` e `ia-loop:recover` leem e escrevem em
  `docs/migration/` (convenção do projeto de origem). Sem esses documentos,
  eles falham com um erro de domínio limpo (`Blocker: [...]`) em vez de um
  crash. Esse é o comportamento esperado até que o Relay Loop IA tenha seu
  próprio fluxo de Goals independente de qualquer projeto específico.
- **Identificadores internos** (variáveis de ambiente `IA_LOOP_*`, prefixo
  `ia-loop:` dos scripts, nomes internos de log/estado) ainda refletem o nome
  anterior do projeto. O rename é só de branding externo por enquanto.

Limitações técnicas mais finas (auth por subprocesso, kill em timeout no
Windows, precisão de custo, cobertura de telemetria por estágio, entre
outras) estão listadas em detalhe na seção "Limitações conhecidas" do
[log de engenharia](docs/ENGINEERING_LOG.md).

## Testes

```bash
npm test
```

1617 testes via `node:test`, nenhum com chamada real a modelo. Processo e
agente são sempre fake nos testes, e isso é verificado explicitamente (ver
`lib/direct-execution.mjs` e os testes de `worker-loop`).

## Histórico

A construção completa do projeto, versão a versão, com a motivação e o defeito
concreto por trás de cada decisão de design, está em
[docs/ENGINEERING_LOG.md](docs/ENGINEERING_LOG.md).
