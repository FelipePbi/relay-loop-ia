# Relay Loop IA

**Relay Loop IA** é um orquestrador autônomo de agentes de IA para automação de
projetos de engenharia de software. Ele conduz um Goal (uma unidade de
trabalho) do início ao fim sem intervenção humana — implementação, revisão,
correções, aceite e fechamento — coordenando dois papéis de agente (um Tech
Lead que planeja e revisa, um Developer que implementa) sobre um protocolo
próprio de jobs, leases e worktrees em disco, com recuperação de falhas,
roteamento adaptativo de modelo e telemetria de custo desde a primeira chamada.

Foi extraído do `tools/ia-loop/` do monorepo `atendly-ia`, onde nasceu e foi
usado em produção para conduzir uma migração real de dezenas de Goals
sequenciais. Este repositório é a versão standalone: mesmo motor, pronta para
ser usada em outros projetos e domínios além daquele em que nasceu.

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
  roteada para o modelo mais barato capaz de resolvê-la — ou para nenhum
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
  persistente (modelo padrão `claude-fable-5-1`) e é responsável por planejar
  e revisar. O **Developer** roda como processo stateless por rodada (modelo
  padrão `claude-opus-5`, mas com roteamento adaptativo — veja abaixo), e é
  responsável por implementar.
- **Protocolo em arquivo, não em banco.** Jobs, leases, resultados e o estado
  da run autônoma vivem em `.state/` como JSON/JSONL com escrita atômica
  (arquivo temporário + rename). Não há dependência de um banco externo para
  o protocolo em si — só uma ledger opcional em SQLite para telemetria de uso.
- **Cada etapa roda isolada em um worktree git próprio**, para que o trabalho
  em andamento nunca colida com o branch principal nem com outra etapa
  concorrente.
- **Leases em vez de locks ingênuos.** Um job é reivindicado atomicamente;
  uma lease nunca declara um worker morto por hábito — só depois de evidência
  (heartbeat expirado + processo comprovadamente ausente).
- **Recuperação depois de um crash ou reboot** é um comando dedicado
  (`ia-loop:recover`), separado da retomada depois de um limite de uso da API
  (`ia-loop:resume`) — são duas situações diferentes e pedem respostas
  diferentes.
- **Roteamento adaptativo de modelo.** Cada Work Unit é classificada por
  natureza e complexidade; unidades determinísticas nunca chamam modelo, e
  unidades que precisam de modelo são roteadas por sinais explícitos (não por
  "sempre o mesmo modelo para tudo").
- **Telemetria de custo desde a primeira chamada.** Toda execução de modelo
  vira uma linha no ledger de uso — tokens, custo reportado pelo provider,
  modelo servido de fato (nunca assumido) — o suficiente para comparar
  cenários (`ALL_OPUS` hipotético, por exemplo) contra o que realmente
  aconteceu.

Cada uma dessas decisões de design tem sua motivação registrada em detalhe no
[log de engenharia](docs/ENGINEERING_LOG.md) (30 versões, V1 a V30).

## Resultados em produção (Atendly)

Números abaixo vêm do ledger real de uso do projeto de origem (`atendly-ia`),
extraídos via `run-metrics.mjs` sobre mais de **70 Goals** já concluídos —
não são projeção nem simulação. Cobertura de custo do provider: 99,6%.

**Roteamento determinístico vs. LLM.** Das 2.389 unidades de trabalho
registradas no ledger, 1.242 (52%) foram resolvidas em código, sem chamar
nenhum modelo, e 1.147 (48%) exigiram uma chamada de LLM.

**Economia de custo, em duas camadas separadas:**

- **Roteamento de modelo** (LLM mais barato capaz da tarefa, em vez de sempre
  o mesmo modelo): custo real $3.318,41 contra um baseline hipotético
  "tudo em Opus" de $4.923,11 — economia de $1.604,70 (32,6%). Quase toda essa
  economia vem do Sonnet ($1.566,99); o Fable, quando usado, custou $152,71
  **a mais** que Opus, não menos.
- **Desvio para execução determinística** (unidades que nunca chamam modelo):
  ~1.242 chamadas de modelo evitadas, economia estimada entre $1.178,67 e
  $5.175,93 (ponto central $2.511,37; confiança **LOW**, n=589 — estimativa,
  não medição direta).
- **Total combinado estimado:** entre $2.783,37 e $6.780,63, ponto central
  $4.116,07 — rotulado **ESTIMATED**, nunca apresentado como medição exata.

**Custo por unidade de trabalho:** ~$3,33 por Work Unit bem-sucedida;
~$51 por Goal em média (mediana $42; mínimo $3,42; máximo $198,66; sobre 64
Goals com custo registrado, soma $3.281,34).

**Fallback e escalação entre modelos são raros e sempre por motivo técnico
explícito**, nunca por "o modelo travou" ou falha de qualidade: 32 de 1.147
chamadas (2,8%) — 10 fallback (todos por `USAGE_LIMIT`) e 22 escalação
(13 `TOOLING_PERMISSION_DENIED`, 6 `PLAN_INCOMPATIBILITY`,
2 `COMPLEXITY_DISCOVERED`, 1 `REVIEW_INCONCLUSIVE`). No nível de job, 31 de
1.041 (3,0%) tiveram fallback ou escalação; desses, 93,5% concluíram — contra
98,7% dos jobs sem fallback/escalação. A tarefa quase sempre termina depois
do fallback, mas a taxa de conclusão cai cerca de 5 pontos.

**Achado que corrigiu o próprio roteamento (V28):** o Fable não era
roteamento adaptativo — era taxa fixa disfarçada. Todo Goal caía nele por
uma regra de segurança (regex `tenant|session|auth`) que batia em
praticamente qualquer arquivo do projeto de origem. Nos últimos 10 Goals
executados depois da correção, o roteamento real é Opus 5.5 + Sonnet 5 em
quase todo Goal, Haiku aparecendo uma única vez, e **zero** Fable — o
`claude-fable-5-1` citado como padrão do Tech Lead acima é o valor de
configuração, não o que o roteamento adaptativo de fato escolhe hoje.

## Requisitos

- **Node.js ≥ 20**
- **CLI do Claude Code** instalado e autenticado no host, visível no `PATH`
  (ou apontado via `IA_LOOP_CLAUDE_BIN`) — é ele quem efetivamente invoca os
  agentes. O Relay Loop IA não fala com nenhuma API de modelo diretamente.

## Instalação

```bash
npm install
```

Não há dependências de terceiros em runtime — só Node builtins. `npm install`
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
| `IA_LOOP_TECH_LEAD_MODEL` | Modelo do Tech Lead (padrão `claude-fable-5-1`) |
| `IA_LOOP_DEVELOPER_MODEL` | Modelo do Developer (padrão `claude-opus-5`) |
| `IA_LOOP_TIMEOUT_MS` | Timeout por processo de agente |

Nenhuma saída do harness imprime prompt completo, token, credencial, session
id ou dado pessoal.

## Estrutura do projeto

```
run-*.mjs        Scripts de entrada (um por comando ia-loop:*)
workers/         tech-lead.mjs e developer.mjs — os dois processos de agente
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
  crash — comportamento esperado até que o Relay Loop IA tenha seu próprio
  fluxo de Goals independente de qualquer projeto específico.
- **Identificadores internos** (variáveis de ambiente `IA_LOOP_*`, prefixo
  `ia-loop:` dos scripts, nomes internos de log/estado) ainda refletem o nome
  anterior do projeto — rename é só de branding externo por enquanto.

Limitações técnicas mais finas (auth por subprocesso, kill em timeout no
Windows, precisão de custo, cobertura de telemetria por estágio, entre
outras) estão listadas em detalhe na seção "Limitações conhecidas" do
[log de engenharia](docs/ENGINEERING_LOG.md).

## Testes

```bash
npm test
```

1617 testes via `node:test`, nenhum com chamada real a modelo — processo e
agente são sempre fake nos testes, e isso é verificado explicitamente (ver
`lib/direct-execution.mjs` e os testes de `worker-loop`).

## Histórico

A construção completa do projeto, versão a versão, com a motivação e o defeito
concreto por trás de cada decisão de design, está em
[docs/ENGINEERING_LOG.md](docs/ENGINEERING_LOG.md).
