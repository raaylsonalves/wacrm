# Sala ao vivo do hub: versão 2

A primeira versão da sala (`/hub`, visão "Sala") posiciona figurinhas por
porcentagem sobre uma imagem pronta de cada sala. Como os móveis fazem parte
dessa imagem, o código não sabe onde eles estão. Os problemas que isso causa:

- personagens se sobrepõem;
- personagens ficam em cima dos móveis (por exemplo, na mesa da Gestão);
- personagens andam em linha reta pelo vazio entre as salas.

## Plano

| Etapa | Entrega |
|---|---|
| **A. Arte** | Salas vazias, móveis soltos e poses novas, gerados no ChatGPT e recortados do fundo verde para `public/hub/`. |
| **B. Motor e profundidade** | PixiJS no lugar dos elementos da página. Móveis e pessoas desenhados por profundidade (pelo "pé" no chão). Pessoas sentadas nas cadeiras de verdade. |
| **C. Mapas e lugares** | Um mapa isométrico por sala com chão andável, bloqueios, lugares de uso (com pose e direção) e saídas (escadas). Editado num editor dentro do hub (`/hub?editor=1`, só para administradores) e salvo em JSON. |
| **D. Caminho e vida** | A* pelo chão, escadas e passarelas. Reserva de lugar e de quadradinho (sem duas pessoas no mesmo ponto). Espera curta quando dois caminhos se cruzam. Pausas ocasionais no bebedouro quando nada muda. |

As regras de quem fica em qual sala continuam em `lib/dashboard/room.ts`
(`placeTeam`). Muda só o desenho e o movimento.

## Regras para todas as gerações de arte

- Use a mesma conversa do ChatGPT em que a sala e os personagens foram
  criados. Anexe a cena aprovada como referência.
- Mesmo ângulo isométrico (personagens virados para o sudeste), mesma escala,
  mesmo traço.
- Fundo **verde puro e liso (#00FF00)**, sem sombra no fundo e sem texto.
- Uma peça ou uma pose por "célula", bem espaçadas, sem encostar umas nas
  outras. O recorte separa as peças pelo espaço vazio entre elas.

## Pedidos

### A1. Salas vazias (1 imagem)

```
Use the attached scene as the exact style reference.

Draw the 5 floor platforms again, COMPLETELY EMPTY: only the floor slab with its thickness and its little staircase. No furniture, no plants, no people, no props, no text.
Same isometric angle, same proportions, same colours as the scene:
1. salmon (#F5A99A) - management
2. soft blue (#9CC9F5) - service, the largest
3. warm yellow (#F7D774) - celebration
4. mint (#8FD9C4) - reception
5. lilac (#C9B6F2) - negotiation

Place them in a 3x2 grid with generous green space between them, each one whole and not touching the others. Plain pure green background #00FF00, 1920x1080.
```

### A2. Móveis soltos (2 imagens)

```
Same style and angle as the attached scene. Draw each piece of furniture SEPARATELY, as a single isolated object, evenly spaced in a grid with lots of empty green between them, on a plain pure green #00FF00 background. No floor under them, no shadows on the background, no people, no text.

Image 1 (office): 1. white office desk with a monitor and keyboard  2. navy office chair (seen from behind-left, empty)  3. navy office chair (seen from the front-right, empty)  4. manager's wooden desk with a laptop  5. black executive chair, empty  6. white bookshelf with binders  7. water cooler  8. potted plant (tall)  9. potted plant (small)
Image 2 (lounge and events): 1. cream two-seat sofa  2. cream armchair (facing right)  3. cream armchair (facing left)  4. small round wooden coffee table  5. round wooden meeting table  6. reception counter (white/grey)  7. big wall screen with charts on a salmon frame  8. golden bell on a stand  9. trophy shelf with a golden trophy
```

Peça a imagem 2 numa mensagem separada da imagem 1.

### A3. Poses novas (1 imagem por personagem, os 7)

Anexe a folha de poses atual do personagem e use:

```
Same character, same style, same scale and same camera angle as the attached sprite sheet. Draw ONLY these 5 new poses in one row, evenly spaced, same feet baseline, plain pure green #00FF00 background, no furniture at all, no text:
1. sitting on an invisible chair, facing south-east, hands forward as if typing (NO desk, NO laptop, NO chair drawn)
2. sitting on an invisible chair, facing south-east, relaxed, hands on the lap (NO chair drawn)
3. walking AWAY from the viewer (back view, facing north-west), contact pose: legs apart
4. walking AWAY from the viewer (back view, facing north-west), passing pose: legs together, one knee bent
5. standing, back view (facing north-west), idle
```

As poses "sentado" vêm sem cadeira de propósito: a cadeira do cenário é que
fica sob o personagem. As poses de costas, espelhadas, dão as outras duas
direções. Com as de frente que já existem, o personagem anda nas 4 direções.

## Arquivos que chegam do ChatGPT

Mande as imagens numeradas como acima:

- A1: uma imagem;
- A2: duas imagens;
- A3: uma imagem por personagem, com o nome dele, por exemplo "A3: barba
  laranja".
