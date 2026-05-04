# Migration vers ApexCharts + Flowbite

## 📊 Changements effectués

### 1. **Remplacement des dépendances**
- ❌ Supprimé : `Chart.js 4.4.1` (CDN CloudFlare)
- ✅ Ajouté : `ApexCharts` (CDN jsDelivr)
- ✅ Ajouté : `Flowbite CSS + JS` (CDN jsDelivr)

### 2. **Structure HTML refactorisée**
La section des graphiques a été entièrement restructurée pour utiliser ApexCharts :

```html
<!-- Avant : Canvas Chart.js -->
<div class="chart-container">
  <canvas id="latencyChart"></canvas>
</div>

<!-- Après : Div pour ApexCharts (responsive) -->
<div id="latencyChart" style="width: 100%;"></div>
```

### 3. **Configuration JavaScript**

#### **Line Chart - Latence**
- **Courbe lissée** : `curve: 'smooth'` (spline curve)
- **Dégradé de zone** : Gradient automatique avec `fill: { type: 'gradient' }`
- **Couleurs** : Rouge (#ef4444) pour "Sans cache", Vert (#10b981) pour "MicroCache"
- **Grille épurée** : Axes minimalistes, grille sur Y seulement
- **Responsive** : 3 breakpoints (1024px, 768px)

#### **Gauge Chart - Hit Rate**
- **Type** : Radial bar chart (jauge circulaire)
- **Creux** : 65% de creux pour un rendu visuel élégant
- **Couleur** : Vert (#10b981) pour les hit rates positives

### 4. **Mappage des données existantes**

Les données WebSocket qui venaient de Django/Express sont directement mappées :

```javascript
// Reçu du WebSocket
const p = {
  avgLatencyNocache: 125,  // → latencyData.nocache[]
  avgLatencyCache: 35,     // → latencyData.cache[]
  hitRate: 78.5            // → gaugeChart.updateSeries([78.5])
}

// Mise à jour automatique
pushToLineChart(latNc, latC);  // Maintient une fenêtre glissante de 60 points
updateGauge(hitRate);           // Met à jour le gauge en temps réel
```

## 🎨 Caractéristiques Flowbite

### Visuels apportés
- ✅ Cartes blanches avec `backdrop-filter: blur(20px)` (glassmorphism)
- ✅ Ombres douces `shadow-sm` (0 4px 24px rgba)
- ✅ Coins arrondis `rounded-lg` (16px)
- ✅ Animations fluides et transitions
- ✅ Legend positionnée en haut à droite
- ✅ Tooltip sombre et responsive

### Responsive breakpoints
```javascript
[
  { breakpoint: 1024, height: 250 },  // Tablets
  { breakpoint: 768, height: 220 }    // Mobile
]
```

## 🔧 Configuration ApexCharts - Détails

### Stroke (Trait de la courbe)
```javascript
stroke: {
  curve: 'smooth',      // Courbe lissée (spline)
  width: [2, 2],        // Épaisseur: 2px pour les deux séries
  lineCap: 'round'      // Extrémités arrondies
}
```

### Fill (Remplissage sous la courbe)
```javascript
fill: {
  type: 'gradient',
  gradient: {
    shadeIntensity: 1,
    opacityFrom: 0.45,    // Opacité haut : 45%
    opacityTo: 0.05,      // Opacité bas : 5% (dégradé)
    stops: [0, 100]
  }
}
```

### Axes et grille
```javascript
xaxis: {
  axisBorder: { show: false },  // Pas de bordure
  axisTicks: { show: false },   // Pas de tiques
  labels: { show: false }       // Pas de labels (pas de place)
}

yaxis: {
  min: 0,
  max: 200,              // Plage fixe pour cohérence
  labels: {
    formatter: v => Math.round(v) + ' ms'
  }
}

grid: {
  show: true,
  xaxis: { lines: { show: false } },  // Pas de grille horizontale
  yaxis: { lines: { show: true } }    // Grille verticale seulement
}
```

## 📱 Responsivité

Le graphique s'adapte à 3 tailles d'écran :
- **Desktop** (≥1024px) : Hauteur 300px
- **Tablet** (768-1023px) : Hauteur 250px
- **Mobile** (<768px) : Hauteur 220px

La largeur est toujours **100%** du conteneur parent.

## 🔄 Flux de mise à jour en temps réel

```
WebSocket → updateDashboard(payload)
    ↓
pushToLineChart(latNc, latC)
    ↓
lineChart.updateSeries([
  { data: latencyData.nocache },
  { data: latencyData.cache }
])
    ↓
Graphique rafraîchi (animation 300ms)
```

La fenêtre glissante de 60 points est maintenue automatiquement :
- Nouvel élément ajouté → ancien élément supprimé (FIFO)
- Maximum de données affichées = 60 points

## ✨ Avantages de cette migration

| Aspect | Chart.js | ApexCharts + Flowbite |
|--------|----------|----------------------|
| **Courbes** | Tension configurable | Spline lissée native ✨ |
| **Dégradés** | Manuels (Canvas API) | Automatiques Flowbite ✨ |
| **Responsive** | Complexe, redraw requis | Natif, smooth scaling ✨ |
| **Ombres** | CSS externe | Flowbite intégré ✨ |
| **Animations** | Basiques | Fluides + ApexCharts ✨ |
| **Bundle size** | 300KB | ApexCharts 800KB, mais plus flexible |

## 🛠️ Points importants

1. **Performance** : ApexCharts utilise Canvas/SVG pour le rendu, optimisé pour les graphiques temps réel
2. **Themes** : Les couleurs sont compatibles avec le système de couleurs du dashboard
3. **Interactions** : Les tooltips et la légende sont automatiques
4. **Pas de breaking changes** : Les données WebSocket restent inchangées

## 📝 Exemple de données reçues du serveur

```json
{
  "type": "metrics",
  "payload": {
    "totalRequests": 15420,
    "hitRate": 78.5,
    "speedupFactor": 3.8,
    "avgLatencyNocache": 125,
    "avgLatencyCache": 35,
    "p95LatencyNocache": 180,
    "p95LatencyCache": 50
  }
}
```

Ces données sont directement mappées aux séries ApexCharts sans transformation.
