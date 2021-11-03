import glob
import json
import math
import os
import pgeocode
import random

def generate(filepath):
    location_history = json.load(open(filepath))

    lat_longs = [
        {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [
                    ((loc['latitudeE7'] - 4294967296) if loc['latitudeE7'] > 900000000 else loc['latitudeE7']) / 10000000, 
                    ((loc['longitudeE7'] - 4294967296) if loc['longitudeE7'] > 1800000000 else loc['longitudeE7']) / 10000000
                ]
            }
        }
        for loc in location_history['locations'] if (loc['latitudeE7'] < 900000000 and loc['longitudeE7'] < 1800000000)
    ]
    return lat_longs

ROAD_TRIP_TYPES = [
    'IN_BUS',
    'IN_VEHICLE',
    'IN_PASSENGER_VEHICLE'
]

def generate_years(years):
    nomi = pgeocode.Nominatim('us')

    places = []
    individual_data = {
        "type": "Feature",
    }

    flights = []
    road_trips = []

    for year in years:
        directory = os.path.abspath(f'data/location_history/{year}')
        files = glob.glob(f'{directory}/*')
        for f in files:
            month_data = json.load(open(f))
            for objects in month_data['timelineObjects']:
                if place := objects.get('placeVisit'):
                    if address := place['location'].get('address'):
                        zip_code = address[-9:-4]
                        lat_long = nomi.query_postal_code(zip_code)
                        lat = lat_long.latitude
                        lon = lat_long.longitude
                        if not (math.isnan(lat) or math.isnan(lon)):
                            places.append(
                                {
                                    **individual_data,
                                    "geometry": {
                                        "type": "Point",
                                        "coordinates": [
                                            lon,
                                            lat
                                        ]
                                    }
                                }
                            )
                if activity := objects.get('activitySegment'):
                    # Flights
                    if activity['activityType'] == 'FLYING' and activity['confidence'] == 'HIGH':
                        activity.pop('activities')
                        flights.append(
                            activity
                        )
                    # Road Trips
                    if activity.get('waypointPath') and activity['activityType'] in ROAD_TRIP_TYPES and activity['confidence'] == 'HIGH' and (dist := activity.get('distance')) and dist > 50000:
                        activity.pop('activities')
                        road_trips.append(
                            activity
                        )
    return places, flights, road_trips

def convert_latlng(lat, lng):
    lat = ((lat - 4294967296) if lat > 900000000 else lat) / 10000000, 
    lng = ((lng - 4294967296) if lng > 1800000000 else lng) / 10000000
    return lat, lng

def save(filepath, places, flights, road_trips):
    json.dump(places, open(f'{filepath}/places.json', 'w'))
    json.dump(flights, open(f'{filepath}/flights.json', 'w'))
    json.dump(road_trips, open(f'{filepath}/road_trips.json', 'w'))

if __name__=="__main__":
    # save(generate('data/location_history.json'), 'data/visits.json')
    data_dir = os.path.abspath("../data/location_history")
    years = [x.split("/")[-1] for x in glob.glob(f'{data_dir}/*') if os.path.isdir(x) ]
    places, flights, road_trips = generate_years(years)
    save('data', places, flights, road_trips)
