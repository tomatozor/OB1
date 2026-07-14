# Audit de securite serveur - A6.3

- Version : `A6.3`
- Date de revue : `2026-07-14`
- Perimetre : serveur MCP v2, API REST Agent Memory, acces PostgREST et workers
  planifies adjacents
- Nature : revue statique versionnee du depot, pas un test d'intrusion ni une
  certification

## Conclusion franche

Le serveur dispose de controles utiles et testes : comparaison de cles apres
hachage, registre multi-clients revocable, filtrage explicite par workspace,
write-back evidence-only en attente, promotion reservee a un humain authentifie,
RLS sur les huit tables Agent Memory et suppression logique confirmee. Ces
controles reduisent les erreurs accidentelles et plusieurs escalades directes.

Ils ne constituent toutefois pas une isolation forte entre clients. Une cle MCP
valide donne acces a la meme surface d'outils pour tous les clients ; le
`client_id` authentifie n'est lie ni a un workspace ni a des permissions. Les
fonctions utilisent `service_role`, qui contourne la RLS. Un client compromis
peut donc choisir un autre `workspace_id` sur les routes qui en acceptent un, et
les outils `thoughts` n'ont pas de dimension workspace. L'objectif 8/10 ne doit
pas etre declare atteint tant que ce point et la concentration de `service_role`
ne sont pas traites.

## Surface exposee

| Surface | Authentification | Pouvoir effectif | Preuves |
| --- | --- | --- | --- |
| MCP HTTP | `x-brain-key`, Bearer, et `?key=` seulement si `MCP_ALLOW_QUERY_KEY=true` | Lecture et mutation des thoughts ; recall, write-back et revue non promotrice Agent Memory | `server/index.ts:2927-2981`, `server/index.ts:3002-3028` |
| REST Agent Memory | Cle globale `MCP_ACCESS_KEY`; `REVIEWER_ACCESS_KEY` supplementaire pour les promotions | Recall, write-back, inspection et revue | `integrations/agent-memory-api/index.ts:422-439`, `integrations/agent-memory-api/index.ts:831-843`, `integrations/agent-memory-api/index.ts:1351-1430` |
| PostgREST / RPC | `SUPABASE_SERVICE_ROLE_KEY` cote fonctions | SELECT/INSERT/UPDATE sur les sidecars et RPC `SECURITY DEFINER`; pas de DELETE sur les huit tables | `server/index.ts:9-45`, `integrations/agent-memory-api/index.ts:7-34`, `schemas/agent-memory/schema.sql:1120-1176` |
| Workers / crons adjacents | Principalement `MCP_ACCESS_KEY`; certains acceptent encore `?key=` | Reclassification, consolidation et extraction avec `service_role` et appels LLM | `integrations/consolidation-workers/metadata-norm/index.ts:38-89`, `integrations/entity-extraction-worker/index.ts:31-55`, `integrations/entity-extraction-worker/index.ts:551-564` |

Les jobs `pg_cron` ne sont pas definis dans `server/`. Leur risque vient des
endpoints Edge qu'ils invoquent : une URL de cron contenant une cle peut etre
copiee dans la configuration, les historiques et les journaux. Les workers
adjacents ne beneficient pas automatiquement du registre `MCP_CLIENT_KEYS`.

## Modele de menace et controles en place

### Fuite d'une cle par URL ou journaux

Menace : une cle dans `?key=` peut apparaitre dans les logs de proxy, l'historique
du navigateur, une capture d'ecran, un referer ou une configuration de cron.

Controles : le MCP ignore le parametre sauf activation explicite de
`MCP_ALLOW_QUERY_KEY=true` (`server/index.ts:3007-3018`). En multi-clients, seules
des empreintes SHA-256 sont configurees, le registre refuse les formes ambigues
et les doublons (`server/index.ts:2826-2874`), puis compare des empreintes sur une
boucle de longueur fixe (`server/index.ts:2902-2981`). Les evenements de recall
n'enregistrent ni requete, ni contenu, ni cle (`server/index.ts:67-81`).

Limite : SHA-256 protege la valeur stockee, pas une cle transmise dans une URL.
Les workers de consolidation acceptent encore `?key=` sans feature flag et font
une comparaison directe (`integrations/consolidation-workers/metadata-norm/index.ts:80-89`).

### Prompt injection vers write-back

Menace : du contenu non fiable peut demander a un agent de stocker un secret,
une instruction durable ou un transcript, puis d'utiliser cette memoire comme
autorite.

Controles : le MCP bloque des motifs de secrets, gros blocs de code et contenus
de type transcript avant l'ecriture (`server/index.ts:1430-1441`). L'ecriture
transactionnelle impose `can_use_as_instruction=false`,
`can_use_as_evidence=true`, `requires_user_confirmation=true` et `pending`
(`schemas/agent-memory/schema.sql:520-579`). Le recall MCP exclut les pending a
confirmer (`server/index.ts:627-668`). Une edition par agent retrograde une
memoire instruction-grade en pending/evidence-only
(`schemas/agent-memory/schema.sql:945-996`).

Limite : le detecteur est heuristique. Il ne detecte pas toute injection et ne
neutralise pas les instructions cachees dans un contenu rappele. L'API REST peut
explicitement demander `include_unconfirmed`; le consommateur doit traiter tout
contenu rappele comme donnees non fiables, meme apres confirmation humaine.

### Promotion non autorisee

Menace : un agent confirme sa propre sortie et la rend instruction-grade.

Controles : le MCP refuse `approve`, `confirm`, `merge` et `supersede` avant tout
RPC (`server/index.ts:1702-1744`) et envoie toujours `p_actor_kind="agent"`
(`server/index.ts:1797-1808`). L'API REST compare separement
`REVIEWER_ACCESS_KEY` apres hachage (`integrations/agent-memory-api/index.ts:401-439`)
et exige cette cle pour les actions promotrices avant l'appel RPC
(`integrations/agent-memory-api/index.ts:1351-1430`). Le RPC journalise l'acteur
et la transition (`schemas/agent-memory/schema.sql:1014-1073`).

Limite : la cle reviewer est globale, sans identite individuelle, MFA, duree de
vie courte ni double validation. Sa compromission vaut pouvoir de promotion sur
tous les workspaces accessibles a l'API.

### Acces cross-workspace

Menace : confusion d'identifiant, workspace fourni par un attaquant, relation
inter-workspace ou resultat semantique melange.

Controles : le MCP filtre avant usage par `workspace_id`, projet, canal et
runtime (`server/index.ts:627-668`), pousse le workspace dans
`agent_memory_match`, puis recharge les IDs avec le meme filtre
(`server/index.ts:1162-1236`). Le RPC semantique applique lui aussi le workspace
dans SQL (`schemas/agent-memory/schema.sql:641-680`). Les relations de merge et
supersession doivent cibler une memoire du meme workspace
(`schemas/agent-memory/schema.sql:927-940`). L'API REST repete ces filtres
(`integrations/agent-memory-api/index.ts:531-566`,
`integrations/agent-memory-api/index.ts:926-940`).

Limite critique : ces filtres utilisent le `workspace_id` fourni par le client.
Ni la cle MCP ni la cle REST ne sont liees a une liste de workspaces. Le
`service_role` contourne la RLS ; celle-ci ne constitue donc pas une frontiere de
tenant contre une fonction compromise ou un appel applicatif mal autorise.

### Exfiltration via recherche

Menace : une cle valide enumere ou recherche l'ensemble des thoughts, demande
les contenus restreints, ou retrouve des donnees logiquement supprimees via un
fallback.

Controles : les chemins de recherche filtrent localement les lignes supprimees
et, par defaut, les lignes `restricted` (`server/index.ts:197-251`). `fetch`
impose les deux filtres dans PostgREST (`server/index.ts:1057-1084`). Les outils
de recall et de liste n'ajoutent les lignes restreintes que si
`include_restricted=true` (`server/index.ts:2035-2078`,
`server/index.ts:2112-2159`).

Limite critique : `include_restricted` est une option fonctionnelle, pas une
autorisation ; toute cle MCP valide peut la demander. Les outils `thoughts`
n'acceptent aucun `workspace_id` (`server/index.ts:1845-1873`,
`server/index.ts:1954-1979`). Une cle compromise peut donc exfiltrer le corpus
global, y compris les lignes restreintes par les outils qui exposent cette
option.

### RLS et suppression

Les huit tables sidecar ont RLS activee (`schemas/agent-memory/schema.sql:1079-1086`).
La policy `service_role` est volontairement totale
(`schemas/agent-memory/schema.sql:1088-1118`), tandis que DELETE est revoque et
seuls SELECT/INSERT/UPDATE sont accordes (`schemas/agent-memory/schema.sql:1120-1138`).
Pour les thoughts, `delete_thought` exige `confirm=true` et utilise un RPC de
suppression logique sans fallback destructif (`server/index.ts:2494-2539`).

Conclusion : RLS protege des roles clients non privilegies, mais pas les deux
fonctions Edge qui detiennent `service_role`.

## Risques residuels acceptes a cette version

| Niveau | Risque accepte | Impact |
| --- | --- | --- |
| Critique | Identite client non liee au workspace et outils thoughts globaux | Exfiltration ou mutation cross-tenant apres compromission d'une cle |
| Eleve | `service_role` omnipresent cote fonctions et workers | Compromission d'une fonction = large acces base/RPC, RLS contournee |
| Eleve | `?key=` si `MCP_ALLOW_QUERY_KEY=true`; anciens workers URL-key | Fuite de credential dans URLs, logs et configurations de cron |
| Eleve | `MCP_ACCESS_KEY` global pour REST/workers et fallback MCP sans registre | Blast radius global, rotation sans coexistence pour le legacy |
| Moyen | CORS `*` par defaut sur MCP et en dur sur Agent Memory REST | Toute origine navigateur peut tenter la surface ; la cle reste requise |
| Moyen | `include_restricted` controle par le demandeur authentifie | Le marquage de sensibilite n'est pas une barriere d'autorisation |
| Moyen | Reviewer key globale, sans identite forte ni MFA | Promotion non attribuable individuellement si la cle est partagee |
| Moyen | Filtrage anti-injection heuristique | Poisoning possible si une charge contourne les motifs puis est confirmee |

L'acceptation est operationnelle, pas une declaration de securite. Elle suppose
des secrets forts, une rotation suivie, des logs d'infrastructure correctement
rediges et un nombre limite d'operateurs.

## Recommandations priorisees

### P0 - requises avant de revendiquer 8/10

1. Lier chaque credential a des `workspace_id` autorises et a des scopes
   lecture/ecriture/reviewer ; deriver le workspace de l'identite serveur au lieu
   d'accepter une autorite auto-declaree.
2. Remplacer l'usage general de `service_role` par des RPC et roles minimaux,
   avec controles d'autorisation dans la transaction ; separer lecture, ecriture
   et promotion.
3. Ajouter une vraie frontiere de tenant aux tools `thoughts`, et faire de
   `include_restricted` une permission serveur distincte.

### P1 - prochain cycle

1. Migrer Agent Memory REST et tous les workers/crons vers le meme registre
   multi-clients ; supprimer l'authentification par URL.
2. Rendre CORS deny-by-default en production et appliquer la meme allowlist a
   l'API REST.
3. Ajouter rate limiting, quotas par client, journal d'echecs d'authentification
   sans secrets, alertes d'anomalie et revocation d'urgence testee.
4. Remplacer la reviewer key partagee par des identites humaines courtes,
   attribuables et idealement protegees par MFA.

### P2 - durcissement continu

1. Tester des injections directes et indirectes, y compris Unicode, contenu
   encode et instructions dans les sources rappelees.
2. Ajouter analyse de dependances, SAST, secret scanning et SBOM a la CI.
3. Tester restauration, compromission de cle, rotation et indisponibilite
   OpenRouter/PostgREST lors d'exercices periodiques.
4. Faire realiser un test d'intrusion externe apres l'isolation tenant P0.

## Revue suivante

Revoir ce document apres toute modification du schema d'authentification, des
scopes, de RLS, des RPC `SECURITY DEFINER`, de la politique de sensibilite ou du
chemin de deploiement. A defaut, revue trimestrielle.
