const mapId = 'mapid';

/**
 * Utils
 */

const convertLatLng = (lat, lng) => {
  const newLat = (lat > 900000000 ? (lat - 4294967296) : lat) / 10000000;
  const newLng = (lng > 1800000000 ? (lng - 4294967296) : lng) / 10000000;
  return [newLat, newLng];
}

const midpoint = (latlng1, latlng2) => {
  let offsetX = latlng2[1] - latlng1[1],
    offsetY = latlng2[0] - latlng1[0];
  let r = Math.sqrt(Math.pow(offsetX, 2) + Math.pow(offsetY, 2)),
    theta = Math.atan2(offsetY, offsetX);
  let thetaOffset = (3.14 / 10);
  let r2 = (r / 2) / (Math.cos(thetaOffset)),
    theta2 = theta + thetaOffset;
  let midpointX = (r2 * Math.cos(theta2)) + latlng1[1],
    midpointY = (r2 * Math.sin(theta2)) + latlng1[0];
  return [midpointY, midpointX];
}

/**
 * Main codebase
 */

fetch('./config.json')
  .then(response => response.json())
  .then(data => {
    const { mapConfig, vizConfig, stadiaApiKey, mapboxApiKey } = data;

    // Define map
    let map = L.map(mapId, mapConfig);

    // Add the dark mode tilelayer; you can replace it with other tilelayer if you like
    L.tileLayer(`https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=${stadiaApiKey}`, {
      maxZoom: 20,
      attribution: '© <a href="https://stadiamaps.com/">Stadia Maps</a>, © <a href="https://openmaptiles.org/">OpenMapTiles</a> © <a href="http://openstreetmap.org">OpenStreetMap</a> contributors'
    }).addTo(map);

    // US States

    let usStatesLayer = L.geoJSON([], vizConfig.states).addTo(map, true);

    Promise.all([
      fetch('./visitedStates.json'),
      fetch('data/us-states.json')
      ]).then(responses => 
        Promise.all(responses.map(response => response.json()))
      ).then(function (data) {
        const visitedStates = data[0];
        usStatesLayer.addData(data[1].filter(feature => visitedStates.some(state => 
          state.toLowerCase() === feature["properties"]["NAME"].toLowerCase())))
      }).catch(error =>
        console.log(error)
      );

    // Animation for flight curves

    if (typeof document.getElementById(mapId).animate === "function") {
      var durationBase = 2000;
      var duration = Math.sqrt(Math.log(150)) * durationBase;
      // Scales the animation duration so that it's related to the line length
      // (but such that the longest and shortest lines' durations are not too different).
      // You may want to use a different scaling factor.
      vizConfig.flights.animate = {
        duration: duration,
        easing: 'ease-in-out',
        direction: 'alternate'
      }
    }

    // Road trip data

    fetch('data/road_trips.json')
      .then(response => response.json())
      .then(data => {
        data.map(trip => {
          L.Routing.control({
            router: L.Routing.mapbox(`${mapboxApiKey}`),
            waypoints: trip['waypointPath']['waypoints'].filter(d => d).map(loc => {
              const latLng = convertLatLng(loc['latE7'], loc['lngE7']);
              return L.latLng(latLng[0], latLng[1]);
            }),
            lineOptions: vizConfig.routes,
            show: false,
            createMarker: function () { return null; },
            fitSelectedRoutes: false
          }).addTo(map, true);
        })
      }
      )

    // Flight data
    fetch('data/flights.json')
      .then(response => response.json())
      .then(data => {

        data.map(flight => {
          const latlng1 = convertLatLng(flight['startLocation']['latitudeE7'], flight['startLocation']['longitudeE7']);
          const latlng2 = convertLatLng(flight['endLocation']['latitudeE7'], flight['endLocation']['longitudeE7']);
          const midpointLatLng = midpoint(
            [latlng1[0], latlng1[1]],
            [latlng2[0], latlng2[1]]
          );

          L.curve(
            [
              'M', latlng1,
              'Q', midpointLatLng,
              latlng2
            ], vizConfig.flights
          ).addTo(map);

        })

      }
      )

    // Places data
    fetch('data/places.json')
      .then(response => response.json())
      .then(data => {
        L.geoJSON(data, {
          pointToLayer: (feature, latlng) => L.circleMarker(latlng, vizConfig.points)
        }).addTo(map);
      }
      )

    /* Legend specific */
    var legend = L.control({ position: "bottomright" });

    legend.onAdd = function(map) {
      var div = L.DomUtil.create("div", "legend");
      div.innerHTML += "<h4>Legend</h4>";
      div.innerHTML += `<i style="background: ${vizConfig.points.fillColor}"></i><span>Places visited</span><br>`;
      div.innerHTML += `<i style="background: ${vizConfig.routes.styles[0].color}"></i><span>Road trips</span><br>`;
      div.innerHTML += `<i style="background: ${vizConfig.flights.color}"></i><span>Flights</span><br>`;
      div.innerHTML += `<i style="background: ${vizConfig.states.style.color}"></i><span>States visited</span><br>`;
      
      return div;
    };

    legend.addTo(map);

  }
  )
  .catch(err => console.log(err))
