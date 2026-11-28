> A entrada agora é única: Google Maps / Street View, com a capa clássica do DeLorean. Clique em **Iniciar viagem** para abrir o percurso salvo ou atualizar as imagens.
>
> Áudio: `instrumental.m4a` é empacotado automaticamente. A faixa tenta iniciar já na tela inicial e toca em loop; se o navegador bloquear, use **Ativar som**. A reprodução continua durante a viagem e respeita **SOM ON/OFF** (atalho M). A faixa atual tem aproximadamente 3 minutos (180,8 s). Arquivos com menos de 10 s não são repetidos; nesse caso, uma ambientação instrumental original sintetizada acompanha a condução. As referências abaixo ao modo clássico são documentação histórica.

# 88 MPH

Jogo de viagem no tempo em primeira pessoa, construído com three.js e Vite. Explore o mesmo lugar em quatro épocas, entre no carro, programe uma data e acelere até 88 mph.

## Executar

Requer Node.js 22.12+ (ou versão compatível com Vite 8).

```sh
npm install
npm run dev
```

Abra http://127.0.0.1:5173. O jogo usa WebGL 2, teclado e mouse. O áudio é liberado ao clicar em **Iniciar viagem**. Quando a captura do cursor não estiver disponível, arraste o mouse para olhar.

```sh
npm test       # Datas, estados, física e colisões
npm run build # Versão de produção em dist/
npm run preview
```

## Jogar

1. Use **WASD** para chegar à porta do motorista. **Shift** corre.
2. Pressione **E** para abrir a porta e novamente para entrar.
3. Com o carro parado, pressione **T**. Digite **mês, dia, ano, hora e minuto**, sem separadores, e confirme com **Enter**. **Backspace** corrige. Também há três destinos prontos no painel.
4. Manobre para a estrada. **W** acelera; **S** freia e dá ré; **A/D** viram; **Espaço** aciona o freio de mão.
5. Alcance 88 mph. Ao chegar, freie antes de sair com **E**.

**C** alterna cabine/câmera externa. **H/Esc** pausa e abre ajuda. **M** liga/desliga o áudio. A ajuda oferece redução de clarões e reposicionamento na estrada.

| Destino digitado | Chegada |
| --- | --- |
| `110519550600` | 5 de novembro de 1955, 06:00 — Anos 50 |
| `010118851200` | 1º de janeiro de 1885, 12:00 — Velho Oeste |
| `102120772200` | 21 de outubro de 2077, 22:00 — Futuro |
| `111120262204` | 11 de novembro de 2026, 22:04 — Presente |

As regras de época seguem o planejamento: até 1899, Velho Oeste; 1900–1984, Anos 50; 1985–11/11/2026, Presente; após 11/11/2026, Futuro. O horário determina a luz na chegada. Datas Gregorianas são validadas sem normalização por `Date`.

## Desenvolvimento e verificação

`PLANEJAMENTO.md` contém o escopo original. Os módulos em `src/` separam entrada/estado, carro, épocas, efeitos e interface. Cada época implementa o contrato `build(ctx)` e libera seus recursos ao sair; materiais comuns são compartilhados.

Parâmetros úteis:

- `?era=oldwest&hora=1200&skipIntro=1` — exploração direta.
- `?era=future&hora=2200&skipIntro=1` — futuro noturno.
- `?calib=1` — polígono e áreas de calibração da cabine.
- `?reflections=0` — desliga o reflexo planar do asfalto.

O console expõe `window.__game.debug`: `enterCar()`, `setPosition(x,z,yaw)`, `setDestination('110519550600')`, `setSpeedMph(87)`, `travel('010118851200')`, `look(yaw,pitch)` e `snapshot()`.

Com o servidor ativo, `npm run test:browser` executa o roteiro em Chrome/Chromium via Playwright. Capturas e métricas são gravadas em `artifacts/browser/`. O executável do navegador pode ser configurado conforme o script.

## Assets e escopo

As duas imagens originais permanecem intactas na raiz e têm cópias em `public/img/`. A cabine usa a imagem como geometria ligada à câmera, com para-brisa transparente e projeção deslocada; seus instrumentos são texturas dinâmicas. No modo clássico, o restante da arte é gerado em código e o áudio é sintetizado por WebAudio, sem downloads de assets ou serviços externos. O modo Avenida Paulista usa os serviços oficiais do Google descritos abaixo.

O carro e o cenário são estilizados. Celular/toque, missões, personagens, interiores e salvamento de progresso permanecem fora do escopo. A meta de 60 fps depende da GPU, resolução e custo do reflexo; o teste de navegador registra a medição do ambiente utilizado.

## Avenida Paulista: fotografias e viagem preparada

Abra `http://127.0.0.1:5173/?mode=paulista` ou escolha **Avenida Paulista** na abertura. Esse modo usa a cabine existente e panoramas oficiais do Google, com movimento guiado na avenida. O modo clássico continua em `/`.

### Configuração

1. No [Google Cloud](https://console.cloud.google.com/google/maps-apis/credentials), escolha o projeto, configure o faturamento e habilite **Map Tiles API**.
2. Crie `.env` ou `.env.local`, seguindo `.env.example`, com `VITE_GOOGLE_MAPS_API_KEY`.
3. Restrinja a chave à **Map Tiles API** e configure cotas no projeto Google. A atualização explícita consulta a API pelo servidor Node; opcionalmente use `GOOGLE_MAPS_SERVER_API_KEY` para uma chave de servidor separada. Sem ela, usa a chave já configurada em `VITE_GOOGLE_MAPS_API_KEY`. Reinicie o Vite após mudar a configuração.

Chaves `VITE_*` fazem parte do código enviado ao navegador; sua proteção depende das restrições do Google. Arquivos `.env` e `.env.local` estão no `.gitignore`; não inclua seus valores em relatórios ou capturas de tela. Sem chave no navegador, o botão de atualização fica desativado. O acervo em disco usa o namespace da chave configurada no servidor; mantenha essa configuração para reencontrar os arquivos.

### Acervo e percurso

O portal é a Avenida Paulista, nº 1508, perto do MASP. Foram observadas no Google Maps capturas de fevereiro/2010 e novembro/2024, com alternativas de abril/2011 e novembro/2013. **Existir no site Google Maps não garante acesso pela API nem cobertura contínua.** Ao escolher **Atualizar com Google**, o aplicativo valida os metadados oficiais, tenta os anos históricos nessa ordem e mostra a captura realmente retornada.

A descoberta segue links oficiais nas duas direções, com alvo de aproximadamente 1 km de cada lado. Exige pelo menos 400 metros de aproximação e 250 metros após o portal. A distância acompanha o traçado da avenida e a câmera acompanha suas curvas. O acervo histórico preserva o ano escolhido; o recente admite capturas de diferentes anos dentro da janela recente verificada e informa a data de cada imagem. Desvios para outras ruas, lacunas grandes e percursos incompatíveis entre épocas são rejeitados. Os IDs são referências que podem expirar; não há substituição por imagens sintéticas quando o Google falha.

### Jogar

Clique em **Usar acervo local** para abrir o percurso salvo e ler as imagens do disco, sem criar sessão, consultar metadados ou baixar imagens do Google. A validade HTTP antiga não impede a leitura dos originais arquivados. Se faltar o percurso, a tela informa isso e mostra quantos arquivos existem. Se faltarem imagens, a verificação conta todos os blocos ausentes e panoramas completos, sem iniciar downloads nem liberar uma viagem incompleta.

**Atualizar com Google** é uma ação separada que consome cota da API. Se `route.json` já existe, ele é reaproveitado (sem nova descoberta do percurso) e só as imagens ausentes são baixadas; a descoberta só roda quando não há percurso salvo ou quando um panorama salvo deixou de existir no Google. Quando o Google responde 429 (limite por minuto), o servidor local espera e tenta de novo (2 s, 5 s, 15 s, 30 s, 60 s) antes de desistir. O limite diário (por padrão 15.000 blocos de Street View por dia por projeto) é reconhecido na hora, sem novas tentativas: ele volta à meia-noite do horário do Pacífico ou pode ser aumentado em Google Cloud → Map Tiles API → Cotas. Uma interrupção ou erro de cota não apaga o percurso nem os arquivos já gravados. Os MB reaproveitados e recebidos do Google aparecem separadamente. A partida só é liberada após verificar o percurso completo e preparar origem, chegada, seis panoramas adiante na época atual e três adiante no destino.

- **W** acelera; **S/Espaço** freiam; arrastar o mouse controla o olhar na cabine.
- **T**, com o carro parado, abre o destino. **H/Esc** pausa; a pausa oferece redução de clarões e nova aproximação.
- O velocímetro principal mostra **km/h**; o LED temporal conserva mph. O salto acontece no ponto fixo, a **88 mph / 141,62 km/h**. Sem chegada pronta, a velocidade fica limitada a 87 mph e o portal não pode ser ultrapassado.
- Se chegar ao portal sem velocidade suficiente, inicie uma nova aproximação. Ao terminar o percurso, faça outra aproximação para voltar à outra época.

Os panoramas são fotografias de posições capturadas. Durante a direção, um conjunto limitado de seis imagens adiante é decodificado e preparado a partir dos bytes já baixados; três imagens após a chegada também ficam preparadas para o salto. Não se mantém o percurso inteiro na GPU. A física conserva a distância entre imagens e usa passos de 1/120 s, evitando que a velocidade indicada dependa da taxa de quadros. A aceleração da simulação é gradual para permitir dosar o acelerador: cerca de 18,6 s de 0 a 100 km/h e 31 s (≈700 m) até 88 mph. Com os circuitos armados, a velocidade fica limitada a exatamente 88 mph até o ponto de viagem, de modo que o salto sempre ocorre a 88 mph. Se uma imagem ainda não estiver pronta, a interface informa a espera, sem apresentar uma velocidade como se houvesse avanço. A troca temporal é síncrona e não faz requisições. Créditos, datas e links de relato de problemas permanecem visíveis; dia e hora dos circuitos são fictícios.

### Imagens no computador e reutilização

No desenvolvimento local, o Vite oferece um serviço privado em `127.0.0.1` que arquiva os bytes originais em **`.cache/streetview/`**, dentro do projeto. Apesar do nome legado da pasta, esse é agora um **acervo permanente**: não há expiração, limpeza por idade ou remoção automática por tamanho. Os arquivos existentes são adotados sem migração, incluindo os que ultrapassaram a antiga validade de uma hora. Arquivos incompletos ou corrompidos são ignorados, mas preservados para recuperação. A pasta está no `.gitignore`; não a apague ao limpar o projeto.

O percurso é salvo como `route.json` junto das imagens, com posições, sequência, dimensões, datas e créditos. Os namespaces continuam separados pelo SHA-256 da chave do servidor, sem guardar chave nem token nos arquivos. Não troque a chave para procurar os arquivos antigos. A leitura do acervo não depende de autorização ou disponibilidade do Google. O serviço é exclusivo do Vite local (`npm run dev`); a versão estática publicada e `vite preview` não expõem os arquivos do computador.

Cada nova imagem recebe um nome exclusivo e é criada sem permissão de sobrescrita. Mesmo uma reparação preserva a imagem anterior; só o índice JSON é atualizado por renomeação atômica. Imagens órfãs ou de gravações interrompidas também permanecem no disco. Não há limite de retenção configurado por padrão; se limites forem passados programaticamente, novas gravações são recusadas em vez de remover imagens antigas. Falta de espaço gera erro, preservando os originais já salvos. Arquivos apagados pela implementação anterior não podem ser reconstruídos a partir do acervo restante.

O provider mantém até 16.384 blocos / 512 MiB em memória para dirigir sem novas leituras. Remover um blob dessa memória ou encerrar a sessão não remove sua cópia no disco. As respostas do servidor local usam `Cache-Control: no-store` para separar o acervo explícito do cache HTTP do navegador. No modo local, um arquivo ausente resulta em erro, nunca em fallback para a API.

O cache temporário do navegador continua disponível apenas como fallback no modo de atualização quando o serviço de disco não existe. Ele mantém as regras anteriores de validade e limites (8.192 blocos / 256 MiB); não é o acervo permanente. O modo local exige o servidor do projeto e não recorre a esse fallback.

### Verificação do modo fotográfico

`npm test` inclui testes de sessão, erros, datas, cobertura, fallback histórico, cancelamento, prontidão GPU, portal e troca sem rede. `npm run build` verifica a compilação.

Em **26/11/2026**, a validação com a API real confirmou um percurso de **1.914 metros**, com o portal após **1.004 metros**, e o salto a 88 mph concluído com a imagem de 2010. O trajeto reúne **361 panoramas**: 178 de fevereiro/2010 e 183 recentes, com datas entre agosto/2021 e novembro/2024, informadas na interface. O download completo confirmou **10.840 tiles gravados em disco**, totalizando **341.283.929 bytes (325,5 MiB)** em `.cache/streetview/`. Cada resposta confirmou a persistência, e o estado final do serviço registrou todos os arquivos. Esse registro descreve a implementação anterior de cache temporário; não representa um inventário dos arquivos atualmente disponíveis.

No teste final neste computador, o percurso completo terminou em 2010 com um salto concluído (`travelCount: 1`), **zero eventos de espera por imagens** (`bufferEvents: 0`) e **zero milissegundos em espera** (`bufferedMs: 0`). A sessão reteve 341.283.929 bytes de imagens e registrou 5.400 reutilizações de blobs em memória (`memoryHits`). Esses números descrevem essa execução; não estabelecem uma taxa de quadros garantida nem disponibilidade permanente do acervo.

Para o ensaio de navegador isolado, inicie em outro terminal:

```sh
STREET_DISK_CACHE=0 VITE_GOOGLE_MAPS_API_KEY=browser-test-only npm run dev -- --port 5174 --bypass-lock
npm run test:street:browser
npm run test:street:local
```

O teste intercepta todas as chamadas ao Google e usa tiles de cores identificados como fixtures. Valida pixels da prévia, redimensionamento, aceleração real pelo teclado, salto com rede offline, reutilização do recurso preparado, retorno/memória e erro de acesso. Os resultados ficam em `artifacts/street-browser/`. Esse ensaio **não comprova o acervo real**; a integração real precisa passar pela verificação dentro do aplicativo usando sua chave.

O diagnóstico `window.__street.snapshot()` informa estado, preparação, posição, métricas e memória, sem expor a chave. A arquitetura está em `src/street/`: provider oficial, descoberta da rota, renderização panorâmica, controlador e interface. Referências: [Street View Tiles](https://developers.google.com/maps/documentation/tile/streetview) e [políticas de uso](https://developers.google.com/maps/documentation/tile/policies).

O teste `test:street:local` usa um acervo temporário com imagens de validade HTTP vencida em 2020, reabre a viagem após recarregar a página e verifica ausência de chamadas ao Google. Também cobre percurso ausente, imagens incompletas e atualização somente por clique explícito. Resultados em `artifacts/street-local-browser/`.

## Linha do tempo em vídeo (experimental)

Ferramentas de linha de comando em `scripts/timeline/` preparam uma viagem em vídeo gerado por IA (MAGI-2 via API do Higgsfield): a aproximação no presente interpolada entre fotos reais e uma Avenida Paulista de 1955 recriada. O jogo ainda não usa esses vídeos; por ora há só o teste de visual.

- **Credencial:** `HF_CREDENTIALS=id:segredo` no `.env` (chave de console.higgsfield.ai). Só os scripts Node a leem; ela nunca vai para o navegador, para o armazenamento de upload nem para a CDN de saída.
- **Quadros-chave:** `node scripts/timeline/keyframes.mjs --at 843.6,portal --zoom 5` renderiza a vista frontal com o enquadramento da cabine (1920×1080, f = 960 px, ponto de fuga em 720, 600). O zoom 5 baixa só os blocos frontais (~52 por panorama, cota do Street View) para `.cache/timeline/tiles/`, separado do acervo do app; `--zoom 3` usa apenas o acervo; `--dry-run` conta os blocos.
- **Conferência:** com `npm run dev` ativo, `node scripts/timeline/parity.mjs` compara um quadro renderizado com a tela do app (SSIM) sem consultar o Google.
- **Geração:** `node scripts/timeline/generate.mjs plan` estima o custo de cada item pelo `/estimate` (grátis). `run --max-usd 6` executa em fila serial com teto obrigatório, para antes de qualquer envio se um item custar mais que o previsto e retoma de onde parou. `status`, `select I4` (escolhe a chegada em 1955) e `retry T2` completam o fluxo.
- **Revisão:** `node scripts/timeline/review.mjs` gera prévias pelo para-brisa, folhas de contato, a posição estimada quadro a quadro e `artifacts/timeline-lookdev/index.html` (abra pelo servidor de desenvolvimento).

Originais pagos e o histórico de gastos (`state.json`, `ledger.jsonl`) ficam em `.cache/timeline/paulista/`, nunca sobrescritos. O conteúdo deriva de imagens do Street View: mantenha-o local e revise os termos do Google Maps Platform antes de publicar qualquer resultado.
