# Lecteur YouTube pour Focus Hub

Page statique hébergée sur GitHub Pages. `index.html` charge `player.js?v=2`.

## Protocole 2

Le parent utilise le canal `focus-hub-youtube`, vérifie la source et l’origine, et transmet une session via le paramètre URL `session` et dans chaque commande. Les événements exposent `protocolVersion: 2`, `session` et `transitionId`.

Une commande `loadMedia` avec `externalController: true`, `protocolVersion: 2` et un nouveau `transitionId` active le pilotage externe. Focus Hub fournit la vidéo à charger et détient le parcours persistant. Le lecteur signale la lecture confirmée, `trackEnded` et les erreurs ; il n’avance pas lui-même. Les doublons et transitions périmées sont rejetés.

Les snapshots distinguent `requestedVideoId` de `confirmedVideoId`. Les commandes d’affichage conservent le temps de lecture. Les clients sans session conservent le comportement autonome précédent.

## Livraison et tests

Publier cette version avant l’application Focus Hub qui utilise le nouveau parcours. L’application désactive le mode sans répétition si elle ne détecte pas le protocole 2.

Les tests de protocole sont dans le projet voisin Focus Hub : `npm test`. Ses tests navigateur utilisent Chrome et Node, sans dépendance supplémentaire : `node tests/browser-music.cjs`, puis `node tests/browser-music.cjs --live` pour YouTube réel. Ils testent le lecteur local avant publication.
