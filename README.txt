VIBE ARCADE - NOVA PÁGINA INICIAL
==================================

Ao abrir index.html você verá dois menus: BIBLIOTECA e EMULADORES.
O VBA-M está em vba.html; a lista dos outros emuladores está em
emuladores.html?core=<identificador>.

BIBLIOTECA
- 9 ROMs Pokémon, 6 GBA e 3 GBC, agora incluídas na pasta roms/.
- Use busca e filtro GBA/GBC. Clique no jogo para abrir vba.html?rom=<id>.
- Somente a ROM escolhida é descompactada e executada.
- No VBA-M, abra Ferramentas > Trapaças ou Cheats prontos para gerenciar
  os presets específicos do jogo. Saves continuam armazenados por ROM.
- Também é possível importar uma ROM do próprio dispositivo no VBA-M.

EMULADORES
- VBA-M, SameBoy, gameboy-emu, Snes9x e PPSSPP estão integrados.
- Azahar, Dolphin, PCSX2 e Eden são experimentais.
- Project64, RPCS3, shadPS4 e xemu constam como pendentes, sem jogos.
- Para núcleos maiores pode ser obrigatório servir via HTTP(S), com HTTPS,
  SharedArrayBuffer ou cabeçalhos de isolamento de origem. Veja _headers.

COMO EXECUTAR
1. Extraia o ZIP inteiro, mantendo assets/, roms/, web/ e os arquivos HTML.
2. Abra index.html; para apenas VBA e os jogos GBA/GBC, geralmente funciona
   mesmo via file://. Se o browser bloquear recursos, sirva por HTTP local.
3. Para emuladores experimentais, use hospedagem com headers COOP/COEP.
4. Não altere o endereço do site se quiser manter os saves: o armazenamento
   do navegador pertence à origem atual. Exporte backups para segurança.

CHEATS
Os cheats foram mantidos do catálogo ampliado (274 presets, mais seletores
de espécies) e têm compatibilidade dependente da revisão da ROM.
Registrar cheats na memória do núcleo não garante seus efeitos em jogo.
Leia FONTES-E-CHECAGENS.txt e RELATORIO-DE-VALIDACAO.txt.

DIREITOS
As ROMs foram reaproveitadas do ZIP previamente enviado pelo usuário.
Não publique nem redistribua ROMs comerciais sem autorização adequada.

==================================
INFORMAÇÕES DO PROJETO ORIGINAL
==================================
VBA WEB
Porte do VisualBoyAdvance-M 2.2.3 para WebAssembly

ABRIR

Extraia o ZIP inteiro e abra index.html em um navegador atualizado. O núcleo
carrega a partir do próprio pacote e a emulação roda no navegador. Na cópia
local, as nove ROMs incluídas são carregadas da biblioteca. Saves e BIOS
continuam locais. Para hospedar o site, veja a seção Cloudflare Pages.

Para servir a pasta localmente, execute nela um dos comandos abaixo.
    Windows   py -m http.server 8000
    Linux     python3 -m http.server 8000
Abra http://localhost:8000/ no navegador.

JOGAR DIRETAMENTE NO SITE

No VBA Web, abra Emuladores e clique em Jogar no navegador. Você também
pode abrir emuladores.html. Use Escolher arquivo para carregar um jogo
de Game Boy no gameboy-emu ou um cartucho de Super Nintendo no Snes9x.
O SameBoy abre arquivos de Game Boy e Game Boy Color e os três jogos de
Game Boy Color da biblioteca.

Para PPSSPP, Azahar, Dolphin, PCSX2 e Eden, clique duas vezes em Jogar no
navegador.cmd no Windows. O arquivo usa o Node.js para abrir o site no
Chrome, Edge ou outro navegador padrão em http://127.0.0.1:8764/emuladores.html.
Mantenha a janela do servidor aberta ao jogar. Em outros sistemas, execute
node serve-web.mjs na pasta do projeto e abra o endereço mostrado.

PPSSPP abre arquivos de PSP. Azahar abre arquivos compatíveis de Nintendo
3DS e programas homebrew. O porte experimental do Dolphin carrega imagens
de disco. A execução foi testada com GameCube. O porte usa controles de
GameCube e a compatibilidade com jogos de Wii é experimental.

PCSX2 usa o porte TabStationToo. Importe a BIOS do seu PS2 e selecione uma
imagem de disco, como ISO ou CHD. O núcleo lê o disco em partes e guarda
os cartões de memória no navegador. O renderizador usa WebGPU quando
disponível e oferece renderização por software.

Eden usa o porte Eden Web e requer WebGPU e suporte a WebAssembly Memory64.
Para Kirby and the Forgotten Land, selecione Wasm JIT. Em Arquivos do
sistema, use Importar chaves para o prod.keys e Importar firmware para o ZIP
do seu Switch. Se já tiver escolhido a ROM, clique em Abrir jogo depois de
importar. Você também pode importar primeiro e selecionar a ROM em seguida.
Homebrews .nro podem abrir sem esses arquivos. As chaves, o firmware e os
saves ficam no perfil e no endereço do site usados no navegador.

Os saves ficam no perfil do navegador e no endereço em que o jogo foi
aberto. Para usar os saves do VBA Web gerados pelo index.html aberto
diretamente, abra esse mesmo arquivo na pasta que já usava. Ao mudar de
endereço, use Baixar .sav e Importar save para levar o progresso. O SameBoy
guarda seu próprio save mesmo quando você escolhe o mesmo cartucho no VBA.

Há 12 ZIPs na pasta emuladores_a_serem_adaptados/Download. O catálogo lista
os 12. Project64, RPCS3, shadPS4 e xemu estão marcados como portes pendentes.
O ZIP mirror-master.zip contém o Eden. O VBA Web é o emulador da página
inicial e fica fora dessa contagem.

Consulte source/web-cores/README.txt para as versões, fontes e licenças.

CONFIGURAR CONTROLES

No Eden, SameBoy, gameboy-emu, Snes9x, Azahar e Dolphin, abra Controles
ou Configurar controles antes de carregar um jogo ou durante a partida.
Selecione o comando, pressione uma tecla ou escolha o controle físico e
pressione um botão ou mova um analógico. As mudanças entram em vigor ao
fechar o painel e são salvas neste navegador. Cada emulador guarda seu
mapeamento de teclado e um perfil para cada modelo de controle detectado.

No VBA Web, abra Controles na página principal. No PCSX2, abra Controles e
selecione os botões do controle na tela. No PPSSPP, use Menu e controles
durante o jogo e abra Configurações → Controles para remapear.

PUBLICAR NO CLOUDFLARE PAGES

Envie a pasta dist ao Cloudflare Pages pelo upload de arquivos estáticos.
Depois de editar o projeto, gere um novo pacote com
node prepare-cloudflare.mjs nome-da-pasta.

O comando verifica o limite de 25 MiB por arquivo e inclui _headers para
manter o isolamento necessário aos emuladores com múltiplas threads.
O pacote público aceita a importação de jogos pelo navegador. O pacote
contém o site e os núcleos WebAssembly. ROMs, chaves e firmware são
selecionados pelo jogador em seu próprio dispositivo.

Em outra hospedagem estática, sirva o pacote em HTTPS, use application/wasm
para os arquivos .wasm e envie os dois cabeçalhos em todas as páginas e
recursos dos emuladores:
    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

CENTRAL DE EMULADORES NO WINDOWS

Extraia o ZIP inteiro e abra Central de Emuladores.exe. Escolha o emulador
na lista. O VBA Web abre o index.html no navegador padrão. Você também pode
abrir o index.html diretamente.

O gameboy-emu vem pronto para Windows x64. Escolha um cartucho .gb compatível
com o Game Boy original. O save .sav fica ao lado do cartucho. Use Z e X
para A e B, Enter para Start, Backspace para Select e as setas para mover.

Para os outros emuladores, use Baixar emulador para encontrar a versão do
Windows ou aponte para uma instalação que você já tenha. Selecione Vincular
executável e escolha o .exe na pasta do emulador. A central guarda o caminho
em emuladores.config.txt na própria pasta. Como alternativa, coloque um
emulador portátil em emuladores/<pasta> com o .exe e os arquivos que o
acompanham. Os nomes de pasta estão na tabela abaixo.

Emulador       Console                     Pasta
SameBoy        Game Boy / Game Boy Color   sameboy
gameboy-emu    Game Boy original           gameboy-emu
Snes9x         Super Nintendo              snes9x
Project64      Nintendo 64                 project64
Dolphin        GameCube / Wii              dolphin
Azahar         Nintendo 3DS                azahar
Eden           Nintendo Switch             eden
PPSSPP         PlayStation Portable        ppsspp
PCSX2          PlayStation 2               pcsx2
RPCS3          PlayStation 3               rpcs3
shadPS4        PlayStation 4               shadps4
xemu           Xbox original               xemu

O Eden corresponde ao arquivo mirror-master.zip. A central inclui os links
oficiais para baixar as onze versões de desktop e usa os próprios emuladores
para abrir os jogos. Os ZIPs em Download.zip contêm o código-fonte.

Use Abrir emulador para fazer a configuração inicial no aplicativo escolhido.
Instale BIOS ou firmware do seu console no próprio emulador quando necessário.
Selecione o jogo na central para abri-lo no aplicativo. Para RPCS3 e shadPS4,
selecione o EBOOT.BIN do jogo instalado ou extraído. No shadPS4 QtLauncher,
configure primeiro o núcleo padrão. Use uma imagem XISO no xemu.
O QtLauncher está em https://github.com/shadps4-emu/shadps4-qtlauncher/releases

JOGAR

Na página inicial, clique em "Escolher jogo" para acessar a biblioteca e selecione
um dos nove cartuchos. Também é possível importar sua própria ROM, usando
"Importar ROM", ou arrastar o arquivo até o site. ZIP e GZIP são aceitos.
Se o ZIP tiver mais de uma ROM, é possível escolher o cartucho. Nenhuma BIOS
da Nintendo é incluída. A BIOS do próprio núcleo pode
iniciar os jogos em geral. Uma BIOS externa pode ser selecionada nas
configurações quando um jogo precisar dela.

A / B        X / Z
L / R        A / S
Direcional   Setas
Start        Enter
Select       Backspace

As teclas e os botões de um controle podem ser alterados em Controles. Os
controles de toque aparecem em telas com toque e podem ser ligados a qualquer
momento nas configurações.

P pausa ou continua. Q ou ESPAÇO aceleram enquanto estiverem pressionados.
Os dois podem ser usados juntos; soltar apenas um deles não encerra a aceleração.
F alterna a tela cheia, que exibe apenas a imagem do jogo em fundo preto,
sem os painéis do site e preservando a proporção original. Escape sai da
tela cheia. C baixa uma captura PNG. A tecla de vírgula avança um quadro. R volta
pelos estados do histórico enquanto estiver pressionada. F1 a F10 carregam
os slots e Shift com essas teclas salva. Os mesmos comandos estão na página.

SAVE E SAVE STATE

Salve pelo menu do próprio jogo e abra o mesmo cartucho para retomar. Nos
nove jogos da biblioteca, além de guardar o save no IndexedDB, o site grava
uma cópia em localStorage ao atualizar o save, inclusive ao fechar a aba.
Ao abrir o jogo, o site usa a cópia mais recente disponível. Os saves de
versões anteriores são lidos pelo mesmo identificador de cartucho.

Use Importar save para trazer o .sav do VBA e Baixar .sav para gerar uma
cópia. Alguns emuladores usam a extensão .srm para os mesmos dados. O arquivo
precisa ter um tamanho compatível com a EEPROM, SRAM ou Flash do cartucho.

Para gravar o ponto exato da execução, selecione um dos dez slots e clique em
Salvar estado. Baixar .sgm exporta o slot selecionado. Importar .sgm abre um
estado diretamente. O núcleo valida a versão do estado, o cartucho e a opção
de BIOS. Ao carregar um estado, o save de cartucho é preservado por padrão.
Nas configurações é possível restaurá-lo junto com o estado. A mesma ROM
tem os mesmos slots mesmo quando o arquivo é renomeado.

Use o mesmo endereço e perfil do navegador para recuperar o progresso. Se
abrir index.html direto do disco, atualize os arquivos na mesma pasta. Em
outro endereço, dispositivo ou perfil, importe suas cópias .sav e .sgm.
A interface informa quando o navegador guarda os dados apenas durante a sessão.

FERRAMENTAS

• Vídeo com correção de cor, escala inteira, filtros clássicos e xBRZ.
• Velocidade de 0,25× a 10×, pulo de quadros, pausa e avanço por quadro.
• Áudio ativo em todas as velocidades (a altura do som varia com a velocidade).
  O antigo padrão que silenciava o som fora de 1× foi desativado inclusive
  para configurações salvas de versões anteriores.
• Captura em PNG/BMP, áudio em WAV e vídeo no formato do navegador.
• Impressora Game Boy com exportação da imagem recebida.
• Códigos VBA, CodeBreaker, GameShark, Action Replay e Game Genie.
• Listas .clt e busca de valores na RAM do GBA.
• Registradores, instruções, RAM, I/O, paletas, tiles, mapas e sprites.
• Patches IPS, UPS, BPS e PPF e arquivos legados SharkPort, GameShark e EEPROM.
• Ajustes de tipo de save, BIOS, RTC, rumble, luz, inclinação e giroscópio.

A edição web cobre a emulação de um cartucho por vez. O Link Cable, o JoyBus
para conectar ao GameCube, a sessão remota GDB, o carregamento de ELF com
símbolos e os formatos nativos de gravação do aplicativo de desktop ficam
fora deste porte. A gravação de vídeo usa WebM ou MP4 conforme o navegador.

BIBLIOTECA INCLUÍDA

Inclui Pokémon FireRed, FireRed (Pokédex completável sem troca), LeafGreen,
Emerald, Ruby, Sapphire, Crystal, Gold e Silver, diretamente do ROMS.zip
fornecido para esta personalização. Os arquivos compactados ficam em roms/.
Cada ROM é carregada somente quando selecionada; não é necessário baixar ou
importar o arquivo manualmente. Funciona com index.html aberto diretamente
(file://) e em hospedagem estática. Ao compartilhar ou publicar este pacote,
verifique se tem autorização para distribuir as ROMs, que podem ser protegidas
por direitos autorais. Evite compartilhar publicamente as ROMs sem ter
os direitos necessários.

CHEATS PRONTOS DE POKÉMON

Abra um dos nove jogos da biblioteca, clique em "Cheats prontos" na área
principal do jogo ou abra Ferramentas > Trapaças. Pesquise o efeito que
procura, filtre por categoria e clique em "Ativar" no cartão do cheat.
Use "Desativar" para remover novamente os códigos deste preset. A lista
é guardada separadamente para cada ROM, no navegador. A inclusão de
códigos manuais continua disponível logo abaixo dos cheats prontos.

Os presets incluem Rare Candy, Master Ball, dinheiro, ganhos elevados de
EXP, modificadores de encontros e opções de batalha. Alguns jogos têm
opções adicionais, como shiny e PP. As opções variam de jogo para jogo;
não existem códigos universais que funcionem em todas as revisões.

Para encontrar um Pokémon específico, digite o nome no campo "Buscar
nome ou ID", selecione o Pokémon e clique em "Ativar" no cartão de
encontros. Se escolher outro Pokémon, a opção anterior é retirada
automaticamente. A lista da Geração 3 inclui os 386 Pokémon existentes
na época. Os números usados são IDs internos da ROM, não necessariamente
o número da Pokédex Nacional. Gold, Silver e Crystal oferecem os 251
da Geração 2.

IMPORTANTE:
• Faça backup do seu .sav antes de testar cheats, especialmente os que
  alteram itens, EXP e encontros. Alguns códigos podem afetar o save.
• Desative o modificador de EXP depois de obter o efeito desejado. "XP
  infinito" é implementado usando códigos de ganho elevado por combate,
  não uma opção genérica que funcione em qualquer ROM.
• Com cheats que substituem itens de loja ou de PC, retire ou compre o
  item desejado e desligue o cheat antes de continuar.
• As ROMs incluídas têm revisões diferentes: FireRed e LeafGreen v1.1;
  Ruby e Sapphire v1.2; Emerald v1.0; Crystal revisão 1; Gold e Silver
  revisão 0. O FireRed modificado usa base v1.0. Códigos encontrados na
  internet podem se aplicar somente à revisão v1.0.
• A interface sinaliza opções de compatibilidade variável. Os formatos
  dos códigos e o catálogo foram validados, mas NÃO foi possível
  comprovar o efeito de cada código no jogo, em todas as revisões.
• Os presets são vinculados aos checksums dos nove cartuchos fornecidos.
  Uma ROM externa pode continuar usando cheats manuais, mas não recebe
  os presets automaticamente sem verificação de compatibilidade.

Fontes de consulta para os códigos:
https://www.pokemoncoders.com/pokemon-fire-red-gameshark-codes/
https://pokemundo.com.br/codigos/pokemon-emerald
https://cheatarcade.com/pokemon-sapphire-cheats
https://www.psypokes.com/gsc/cgameshark.php
https://nintyconservation.github.io/glitchcity.wiki/glitchcity.wiki/Pok%C3%A9mon_Gold_and_Silver_GameShark_codes.html
https://psverso.com.br/guias/cheats-pokemon-leaf-green/

COMPILAR O NÚCLEO

O site em index.html já vem pronto. Para recompilar assets/vbam.js, ative o
Emscripten SDK 4.0.21 e execute make na pasta source. Um ambiente com GNU Make
e tar, como Linux ou WSL, pode executar a compilação. O Emscripten usa a porta
zlib 1.3.1. A fonte correspondente também está em source.

O código web próprio está nos arquivos HTML, CSS e JavaScript legíveis do
projeto, mais source/bridge.cpp e source/file-util-web.cpp. A compilação
extrai o código-fonte original de vba-m 2.2.3 do arquivo em source e o liga à
interface web sem o aplicativo desktop. O binário WebAssembly fica embutido
em assets/vbam.js e funciona em um servidor estático ou direto do disco.

As fontes da central estão em source/central. O script build.cmd compila a
central com o compilador do .NET Framework no Windows. As fontes e os avisos
do gameboy-emu e da SDL2 estão em source/gameboy-emu. Consulte o arquivo
WINDOWS.txt nessa pasta para recompilar esse emulador.

ORIGEM E LICENÇAS

VisualBoyAdvance-M 2.2.3, pelo projeto VisualBoyAdvance-M e contribuintes.
https://github.com/visualboyadvance-m/visualboyadvance-m/releases/tag/v2.2.3

A adaptação do núcleo e o frontend web usam GPL versão 2 ou posterior.
O binário que inclui xBRZ é distribuído sob GPL versão 3. As licenças, os
avisos do VBA-M, a fonte original e os avisos dos componentes de terceiros
estão em source.

OTIMIZAÇÕES DESTA REVISÃO

• Controles físicos são consultados uma vez por atualização visual, não a
  cada quadro emulado, inclusive em velocidades altas.
• Histórico de rebobinar tem captura limitada a aproximadamente 1 por 750 ms
  reais, evitando várias operações caras de save state por atualização em 10×.
• A verificação CRC de cada ROM embutida só é efetuada uma vez.
• Fila circular de áudio tem cópias por blocos; mantém som em todos os
  multiplicadores e descarta amostras antigas em caso de acúmulo.
• O zoom em tela cheia ignora a escala da janela, mas mantém a proporção do
  console. Em celulares, os controles de toque são ocultados no modo tela
  cheia para exibir somente o jogo; use controle físico ou saia com Escape/F.

O som é acelerado ou desacelerado junto com a emulação e pode mudar de tom,
como em emuladores tradicionais. Em velocidades extremas, o desempenho real
continua limitado pelo hardware e navegador. Nenhum save existente é apagado.


CATÁLOGO AMPLIADO E FONTES
As referências completas, revisões e divergências verificadas estão em FONTES-E-CHECAGENS.txt. Um código ser aceito pelo emulador não garante efeito em jogo.

RELATORIO ADICIONAL
Leia RELATORIO-DE-VALIDACAO.txt para ver quais testes foram realmente feitos e FONTES-E-CHECAGENS.txt para as referencias.
