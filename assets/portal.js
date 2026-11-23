"use strict";
// Página principal independente: os núcleos de emulação são carregados apenas ao jogar.
const ROMS = typeof BUNDLED_ROMS !== "undefined" ? BUNDLED_ROMS : [];
const CORES = [
  {id:"vba",name:"VBA-M",platform:"Game Boy / Color / Advance",status:"available",mark:"GBA",href:"vba.html",description:"Jogos Pokémon, cheats prontos, saves e aceleração."},
  {id:"sameboy",name:"SameBoy",platform:"Game Boy e Game Boy Color",status:"available",mark:"GB",description:"Emulador de GB/GBC independente."},
  {id:"gameboy-emu",name:"gameboy-emu",platform:"Game Boy original",status:"available",mark:"GB",description:"Alternativa leve para Game Boy."},
  {id:"snes9x",name:"Snes9x",platform:"Super Nintendo",status:"available",mark:"SNES",description:"Jogos SNES por arquivo local."},
  {id:"ppsspp",name:"PPSSPP",platform:"PlayStation Portable",status:"available",mark:"PSP",description:"Porte Web; pode exigir servidor compatível."},
  {id:"azahar",name:"Azahar",platform:"Nintendo 3DS",status:"experimental",mark:"3DS",description:"Porte experimental; exige recursos modernos."},
  {id:"dolphin",name:"Dolphin",platform:"GameCube e Wii",status:"experimental",mark:"GC",description:"Porte experimental com alto consumo de recursos."},
  {id:"pcsx2",name:"PCSX2",platform:"PlayStation 2",status:"experimental",mark:"PS2",description:"Porte experimental; BIOS e isolamento podem ser necessários."},
  {id:"eden",name:"Eden",platform:"Nintendo Switch",status:"experimental",mark:"NS",description:"Porte experimental; pode exigir WebGPU e arquivos de sistema."},
  {id:"project64",name:"Project64",platform:"Nintendo 64",status:"pending",mark:"N64",description:"Núcleo para navegador ainda indisponível."},
  {id:"rpcs3",name:"RPCS3",platform:"PlayStation 3",status:"pending",mark:"PS3",description:"Jogos ainda não executáveis neste projeto."},
  {id:"shadps4",name:"shadPS4",platform:"PlayStation 4",status:"pending",mark:"PS4",description:"Porte jogável para navegador pendente."},
  {id:"xemu",name:"xemu",platform:"Xbox original",status:"pending",mark:"XB",description:"Núcleo para navegador ainda indisponível."}
];
const $ = id => document.getElementById(id);
const normal = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
let systemFilter="all",coreFilter="all";
const node = (tag,className,text) => { const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el; };
const msg = text => node("div","empty",text);
function drawGames(){
 const term=normal($("game-search").value),grid=$("game-grid");
 const list=ROMS.filter(r=>(systemFilter==="all"||r.system===systemFilter)&&normal(r.title+" "+r.subtitle+" "+r.filename).includes(term));
 const fragment=document.createDocumentFragment();
 for(const r of list){
   const a=node("a","game-card"); a.href="vba.html?rom="+encodeURIComponent(r.id);a.dataset.theme=r.theme;
   a.setAttribute("aria-label","Jogar "+r.title+" no VBA-M com cheats integrados");
   const art=node("div","game-art");art.setAttribute("aria-hidden","true");
   const content=node("div","game-text");
   content.append(node("span","game-kicker",r.system+" · Pokémon"),node("h3","",r.title),node("p","",r.subtitle),node("span","game-play","Jogar agora ›"));
   a.append(art,content);fragment.append(a);
 }
 grid.replaceChildren(list.length?fragment:msg("Nenhum jogo encontrado. Experimente outro termo ou console."));
 $("rom-count").textContent="("+list.length+")";
}
function drawCores(){
 const term=normal($("core-search").value),grid=$("core-grid");
 const list=CORES.filter(c=>(coreFilter==="all"||(coreFilter==="available"?c.status!=="pending":c.status==="pending"))&&normal(c.name+" "+c.platform).includes(term));
 const fragment=document.createDocumentFragment();
 for(const c of list){
   const a=node(c.status==="pending"?"div":"a","core-card");
   if(c.status==="pending"){a.setAttribute("aria-disabled","true");a.title="Pendente: ainda não é possível jogar";}
   else a.href=c.href||"emuladores.html?core="+encodeURIComponent(c.id);
   const mark=node("span","core-mark",c.mark),body=node("div","core-body");
   const statusLabel=c.status==="available"?"Integrado":c.status==="experimental"?"Experimental":"Pendente";
   body.append(node("h3","",c.name),node("p","",c.platform),node("span","core-tag "+c.status,statusLabel));
   a.append(mark,body);a.title=c.description;fragment.append(a);
 }
 grid.replaceChildren(list.length?fragment:msg("Nenhum emulador corresponde à pesquisa."));
}
function setTab(){
 const emulators=location.hash==="#emuladores";
 $("library-section").hidden=emulators;
 $("emulators-section").hidden=!emulators;
 for(const [id,on] of [["nav-library",!emulators],["nav-emulators",emulators]]){
  if(on) $(id).setAttribute("aria-current","page"); else $(id).removeAttribute("aria-current");
 }
}
function bindFilter(container,attr,callback){
 $(container).addEventListener("click",e=>{
  const b=e.target.closest("button["+attr+"]");if(!b)return;
  for(const item of $(container).querySelectorAll("button"))item.setAttribute("aria-pressed",String(item===b));
  callback(b.getAttribute(attr));
 });
}
$("game-search").addEventListener("input",drawGames);
$("core-search").addEventListener("input",drawCores);
bindFilter("game-filters","data-system",v=>{systemFilter=v;drawGames()});
bindFilter("core-filters","data-status",v=>{coreFilter=v;drawCores()});
window.addEventListener("hashchange",setTab);
drawGames();drawCores();setTab();
