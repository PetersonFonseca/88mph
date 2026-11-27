# 88 MPH — jogo de viagem no tempo no navegador

Homenagem a *De Volta para o Futuro*, em three.js, na pasta `/Users/petersonfonseca/back-to-the-future`.

## Contexto

Você quer um jogo de navegador inspirado no filme: é noite, acabou de chover forte, o jogador chega a pé ao carro, abre a porta, entra, digita a data no painel, manobra até ficar de frente para a estrada, acelera até 88 mph e surge na época escolhida — onde pode sair do carro e explorar.

A pasta hoje só tem duas imagens suas (o carro na chuva e o painel, ambas 1672×941). Elas passam a fazer parte do jogo.

Decisões que você já tomou: a cabine usa **a sua imagem do painel**; fora do carro é **primeira pessoa**; qualquer data leva à **época mais próxima**.

## Decisões de projeto

| Tema | Decisão |
|---|---|
| Stack | Vite 8 + three.js 0.187 (versão fixada) + JavaScript puro (módulos ES). Sem motor de física. Node 22 já instalado. |
| Assets | Nada baixado da internet: geometria, texturas (canvas) e sons (WebAudio) são gerados em código. As únicas imagens são as suas duas, copiadas para `public/img/` (originais intactos). |
| Visual | Mundo 3D estilizado (low-poly) com iluminação caprichada: asfalto molhado com reflexos, neon, névoa e bloom. A cabine é fotorrealista (sua imagem). |
| Câmeras | A pé: 1ª pessoa. No carro: cabine (sua imagem) ou câmera externa atrás do carro, alternando com `C`. |
| Mesmo lugar | Todas as épocas são **o mesmo lugar**: mesma estrada reta, mesmo pátio, mesmas montanhas no horizonte, a mesma árvore e a mesma caixa-d'água mudando com o tempo. |
| Datas | até 1899 → Velho Oeste · 1900–1984 → Anos 50 · 1985 até 11/11/2026 → Presente · depois de 11/11/2026 → Futuro. |
| Hora | A hora digitada define dia ou noite na chegada (06:00 amanhece, 12:00 sol a pino, 22:00 noite). |
| Painel | Segue os campos da sua imagem: MÊS · DIA · ANO · HORA · MIN, em 24 h com o LED AM/PM aceso. O "agora" do jogo é 11 NOV 2026 22:04. |
| Idioma | Interface e letreiros em português (pt-BR). |
| Homenagem | Arte e sons originais; sem logotipo, trilha ou personagens do filme. Título provisório "88 MPH" (uma linha em `src/config.js`). |

## Fluxo do jogador

1. Tela inicial com a sua imagem do carro na chuva; ao clicar, ela se dissolve na cena 3D com enquadramento parecido (o clique libera áudio e mouse).
2. A pé, à noite, com garoa fina e relâmpagos ao longe. O carro está parado em diagonal no pátio molhado. `WASD` anda, mouse olha, `Shift` corre.
3. Perto da porta do motorista: `E` abre (a asa de gaivota sobe), `E` de novo entra.
4. Na cabine: `T` liga os circuitos do tempo e aproxima o painel; os dígitos entram campo a campo; `Enter` confirma, `Backspace` apaga.
5. `W/S` acelera e freia/dá ré, `A/D` vira, `Espaço` é o freio de mão. O jogador manobra para fora do pátio até alinhar com a estrada. `C` alterna a câmera.
6. Acelerando na estrada: a partir de ~75 mph surgem arcos elétricos; aos 88 mph vêm três clarões, o carro some e ficam dois rastros de fogo.
7. Chegada na época escolhida, ainda a 88 mph — é preciso frear. Um cartão mostra a data e o nome da época.
8. Com o carro parado, `E` sai. O jogador explora a pé, volta, entra e viaja de novo.

## Arquitetura

```
index.html · package.json · vite.config.js · .claude/launch.json
public/img/cockpit.png, capa.png        cópias das suas duas imagens
src/
  main.js            inicialização e laço principal
  config.js          constantes: data "agora", 88 mph, medidas da estrada, teclas, título
  core/
    engine.js        renderer, pós-processamento, conjunto fixo de luzes, aquecimento
    input.js         roteador único de teclado por modo, mouse, pointer lock
    state.js         máquina de estados do jogo
    audio.js         sintetizador WebAudio: motor, efeitos, ambiências
    collision.js     colisores (caixa/círculo) e consultas
    rng.js           aleatório com semente e ruído
    debug.js         window.__game e parâmetros de URL para teste
  player/walker.js   controle em 1ª pessoa
  car/
    carModel.js      carro 3D procedural (carroceria, portas, rodas, luzes, bobinas)
    carPhysics.js    modelo arcade
    carController.js liga entrada → física → modelo; câmeras; entrar/sair
    cockpit.js       cabine: sua imagem presa à câmera, projeção deslocada, partes vivas
    cockpitMap.js    coordenadas calibradas da imagem (para-brisa, campos LED, "88")
    timeCircuits.js  datas: digitação, validação, data → época
  world/
    layout.js        traçado comum a todas as épocas
    eraManager.js    constrói, troca e descarta épocas (com registro do que é de cada uma)
    materials.js     biblioteca única de materiais, compilada na inicialização
    sky.js           céu, sol/lua, estrelas, luz por hora do dia, reflexo de ambiente
    lightPool.js     8 luzes fixas realocadas aos postes mais próximos
    wetRoad.js       camada de reflexo do asfalto molhado
    weather.js       garoa, relâmpagos, poeira
    kit/             texturas canvas, fachadas, letreiros, postes, árvores, carros, mesclagem
    eras/            present.js · fifties.js · oldwest.js · future.js
  fx/
    timeTravel.js    arcos, clarões, rastros de fogo, chegada
    particles.js     sistema de partículas simples
  ui/hud.js, ui/style.css   velocímetro, dicas, cartão de época, ajuda
```

Contrato de cada época (é o que permite reaproveitar tudo):

```js
build(ctx) → { group, colliders, surfaceAt(x,z), lamps, ambience, update(dt,t), dispose() }
// ctx: { date, hour, isNight, wet, rng (semente = época+ano), layout, kit, materials }
```

Estados: `TÍTULO → A_PÉ ⇄ NO_CARRO (cabine | externa) ⇄ PAINEL → PARTIDA → CHEGADA → NO_CARRO`.

## Sistemas principais

**Cabine com a sua imagem** (`cockpit.js`, `cockpitMap.js`)
- A foto é um plano preso à câmera **dentro da cena 3D**, não um elemento HTML por cima. Assim ela passa pelo mesmo bloom, granulação e clarões que o mundo e não fica com cara de colada. O para-brisa é recortado por um polígono calibrado.
- Projeção deslocada: o eixo da câmera fica sempre na direção do carro, e o ponto de fuga da estrada na foto (≈ 640, 120 px) coincide com o do mundo 3D em qualquer tamanho de janela, sem entortar postes e prédios.

```js
s  = 1.06 * Math.max(W / IW, H / (2 * (IH - DASH_Y)));     // vista "dirigir"
ox = (W - s * IW) / 2 + panX;   oy = H / 2 - s * DASH_Y + panY;
f  = s * F;   px = ox + s * VX;   py = oy + s * VY;         // F ≈ 900 px, ajustado a olho
camera.fov = deg(2 * atan(H / (2 * f)));
camera.setViewOffset(W, H, W / 2 - px, H / 2 - py, W, H);
// plano da foto, filho da câmera: vértice = ((u - VX) / F, -(v - VY) / F, -1)
```

- Duas vistas com transição animada: **dirigir** (linha do painel a meia altura; mundo em cima, "88" e circuitos visíveis) e **painel** (zoom nos circuitos do tempo). O mouse só desloca levemente o olhar.
- Partes vivas em texturas pequenas sobre a foto: dígitos LED das três linhas, LEDs AM/PM, caixa "88" e ponteiros. Os dígitos e ponteiros originais da foto são cobertos.
- O topo da foto é estendido (coluna e teto) para a borda não aparecer. O brilho da cabine acompanha a hora do dia, os postes passando, os relâmpagos e os clarões.
- `?calib=1` desenha o polígono e os retângulos para o ajuste fino.

**Carro** (`carModel.js`, `carPhysics.js`, `carController.js`)
- Modelo gerado por seções (cunha de aço escovado, faróis duplos, grade preta, rodas tipo turbina, bobinas azuis, cabos, dutos traseiros) com portas asa de gaivota animadas. O mesmo gerador, com outros parâmetros, faz os carros estacionados de cada época.
- Física arcade: direção limitada pela velocidade, arrasto, ré, freio de mão. Fora da estrada o atrito sobe, então 88 mph só se alcança na estrada. Colisão: três círculos contra caixas e círculos fixos.
- 0 a 88 mph em ~11 s (~230 m); a estrada tem 1,2 km. Velocidade em mph e km/h no HUD.

**Mundo e épocas** (`world/`)
- A época de destino é construída quando a data é confirmada (o jogador ainda está no painel), trocada durante o clarão e a anterior é descartada da memória.
- Na chegada o carro reaparece no eixo da estrada, no mesmo X (limitado para sobrarem ao menos 350 m de frenagem), no sentido em que vinha.

**Céu, luz e clima** (`sky.js`, `lightPool.js`, `wetRoad.js`, `weather.js`)
- Cúpula de céu em shader (gradiente, nuvens, estrelas), um sol/lua com sombra que acompanha o jogador, névoa, e reflexo de ambiente capturado do céu e das luzes a cada chegada (para o aço não ficar preto à noite).
- Postes à noite: lâmpada emissiva + bloom + mancha de luz no chão, mais 8 luzes reais realocadas para os postes mais próximos. Sombra de contato sob o carro.
- Cena inicial molhada, como na sua imagem: uma camada de reflexo sobre todo o asfalto — nítida e ondulada nas poças, esticada na vertical no resto (os riscos de luz dos postes). Garoa leve que vai parando; relâmpagos distantes com trovão.

**Viagem no tempo** (`fx/timeTravel.js`)
- 75→88 mph: arcos elétricos, brilho das bobinas, tremor de câmera e som subindo.
- 88 mph: três clarões, carro some, rastros de fogo nas marcas dos pneus; na câmera externa ela fica ~1,4 s olhando os rastros. Branco total, troca de época, três clarões de chegada, vapor frio no carro.
- Sem data programada, nada acontece aos 88 mph e o painel pisca pedindo destino.
- Clarões espaçados (menos de 3 por segundo) e opção "reduzir clarões" no menu.

**Áudio** (`core/audio.js`) — tudo sintetizado: motor (com marchas), porta, bipes do painel, viagem no tempo, passos por tipo de piso e uma ambiência por época (chuva e trovão; grilos e jukebox; vento e piano de saloon; zumbido e carros voadores).

## Cuidados técnicos

- **Sem engasgos na troca de época:** conjunto de luzes permanente (desligar é intensidade 0, nunca `visible = false`), névoa sempre presente, uma única biblioteca de materiais compilada na inicialização. O branco total só some depois de 3 quadros seguidos abaixo de 20 ms.
- **Sem vazamento de memória:** cada época registra geometrias, texturas e alvos de render que criou e os descarta; o que é compartilhado nunca é descartado.
- **Desempenho:** geometria fixa mesclada por célula de ~120 m (para o corte por câmera funcionar nos passes principal, de sombra e de reflexo), objetos repetidos instanciados, reflexo em meia resolução e desligado em épocas secas, pixel ratio até 1,5.
- **Entrada:** um roteador de teclas por modo (os dígitos do painel nunca dirigem o carro); teclas presas são limpas ao trocar de modo ou perder o foco; perder o pointer lock pausa o jogo.
- **Datas:** sem o `Date` do JavaScript (ele altera anos abaixo de 100); a época sai de `ano*10000 + mês*100 + dia > 20261111`.
- **Pós-processamento:** cena → bloom (limiar ≥ 1, emissivos entre 3 e 10) → tone mapping → granulação fina, que também evita faixas no céu noturno.
- **Conferir no `node_modules/three` logo após instalar:** `compileAsync`, `PMREMGenerator.fromScene`, opções do `Reflector`, `setViewOffset`, unidades de intensidade das luzes.

## As quatro épocas

| Época | Aparência | Detalhes vivos |
|---|---|---|
| **Presente** (cena inicial) | Avenida arborizada como na sua imagem: asfalto molhado, postes, calçadas, gramados, prédio iluminado ao fundo, ponto de ônibus, carros atuais, folhas no chão. | Garoa, poças com reflexo, relâmpagos, luz vermelha na caixa-d'água. |
| **Anos 50** | A mesma avenida como rua principal: lanchonete cromada, cinema com letreiro, posto de gasolina, barbearia, banco com relógio, casas com cerca branca, carros rabo-de-peixe. | Lâmpadas do cinema em sequência, poste de barbeiro girando, neon à noite. |
| **Velho Oeste** | Rua de terra com calçadas de madeira: saloon, xerife, armazém, banco, hotel, ferreiro, estábulo, caixa-d'água de madeira, cactos e mesas ao fundo. | Bolas de feno rolando, moinho girando, poeira, lampiões tremulando. |
| **Futuro** | Via luminosa entre torres com letreiros holográficos, tubos elevados, plataforma de pouso no lugar do pátio, esfera holográfica no lugar da caixa-d'água. | Fluxo de carros voadores, drones; quanto mais distante o ano, mais altas as torres. |

## Ordem de construção

As partes mais arriscadas vêm primeiro; cada marco termina em algo jogável e conferido no navegador.

1. **Base e cabine** — projeto Vite, renderer com pós-processamento, chão de teste com uma faixa de estrada, e a sua imagem como cabine com a projeção deslocada. *Pronto quando:* o ponto de fuga da estrada fica cravado no da foto em 4:3, 16:9 e 21:9 e ao mover o olhar.
2. **Andar e dirigir (em blocos)** — 1ª pessoa com colisão, carro provisório, abrir a porta, entrar/sair, câmera externa, velocidade viva na caixa "88". *Pronto quando:* 88 mph só é alcançado na estrada.
3. **Painel e ciclo de viagem** — digitação da data, data → época, troca entre quatro épocas provisórias (uma cor cada) já no contrato final. *Pronto quando:* o ciclo completo funciona e 10 idas e voltas não aumentam a memória.
4. **Céu e luz** — hora do dia, sombras, reflexo de ambiente, postes. *Pronto quando:* variar a hora de 0 a 23 não recompila nenhum shader.
5. **A noite de chuva** — cena do Presente, asfalto molhado, garoa, relâmpagos, modelo final do carro, tela inicial com a sua imagem. *Pronto quando:* a abertura lembra a sua referência e roda a 60 quadros por segundo em 1080p.
6. **Demais épocas** — Anos 50, Velho Oeste e Futuro, de dia e de noite.
7. **Efeitos e som** — arcos, rastros de fogo, ponteiros vivos, áudio completo, ajuda (`H`), opção de reduzir clarões.

## Verificação

- Servidor de desenvolvimento no painel de navegador do app (`.claude/launch.json` → `npm run dev`), com capturas de tela e leitura do console a cada marco.
- `window.__game.debug` para roteirizar testes: `enterCar()`, `setDestination('110519550600')`, `setSpeedMph(87)`, `travel(...)`, `look(...)`; e URL `?era=oldwest&hora=1200&skipIntro=1` para abrir direto numa época.
- Roteiro de ponta a ponta: começar → andar até o carro → `E`, `E` → `T` → digitar `11 05 1955 06 00` → `Enter` → manobrar → 88 mph → confirmar "Anos 50" ao amanhecer → frear → `E` → andar → voltar e viajar para `01 01 1885 12 00` e para `10 21 2077 22 00`.
- Casos de borda: data inválida (31/02) dá erro no painel; 12/11/2026 já é futuro e 11/11/2026 é presente; 88 mph sem destino não viaja; fora da estrada não chega a 88; redimensionar a janela mantém a cabine alinhada.
- Memória e shaders: `renderer.info.memory` e o número de programas voltam ao valor inicial após 10 viagens de ida e volta.
- `npm run build` sem erros ao final.

## Fora do escopo por enquanto

Celular/toque, salvar progresso, personagens e missões, interiores de prédios. O carro 3D é feito em código; a estrutura permite trocar por um modelo `.glb` depois, se você quiser mais realismo.
