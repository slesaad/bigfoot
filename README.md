# Bigfoot (<img src="/assets/logo.png" />)

Bigfoot is a web app that traces the places you've been to, your road trips and your flights on a map.

- Bigfoot uses the location history data that can be obtained from Google Maps.
- The data is then processed into a format that the frontend data can consume.
- The frontend reads this processed data and renders it in a map.

## Visualizing your own location history

Follow the given steps to set up your own bigfoot visualization.

### Step I: Download data

Download the location history data from your Google Maps account. Check out this [HowTo](https://www.howtogeek.com/725241/how-to-download-your-google-maps-data/) article to learn how to do that.

Copy the downloaded location history folder to the `data/` directory, so it looks like:

``` plain
|data
   |location_history
        |2021
        |2020
        ...
```

### Step II: Process Data

``` bash
> cd backend/
> python -m venv env
> source env/bin/activate
> pip install -r requirements.txt
> python data_generator.py
> cd ..
```

### Step III: Configure visualization

Update `config.json` with necessary configuration changes.

**<span style="color:#c0392b">IMPORTANT</span>**: Please update the API keys by creating your own accounts at [Mapbox](https://account.mapbox.com/access-tokens/) and [Stadia Maps](https://client.stadiamaps.com/dashboard/).

Update `visitedStates.json` with the states you've visited.
<span style="font-size:13px">***TODO***: Automatically get it from location history. (I didn't want to count states that I've had a layover at as "visited")</span>

### Step IV: Serve

Serve the webpage from the root `bigfoot/` directory using python http server.

``` bash
> python -m http.server 3000
```

Open your browser and go to `localhost:3000`

## Disclaimer

The project still is under-development. I plan to update the service to be more user friendly and plug-n-play so that people with no coding skill can set it up. Stay tuned!
