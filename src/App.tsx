import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleMap, useJsApiLoader, Marker, DirectionsRenderer, Autocomplete, InfoWindow } from '@react-google-maps/api';
import { Box, TextField, Button, Container, Typography, Paper, FormControl, InputLabel, Select, MenuItem, SelectChangeEvent, IconButton } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';

const containerStyle = {
  width: '100%',
  height: '500px'
};

const center = {
  lat: 41.0082,
  lng: 28.9784
};

const libraries: ("places" | "geocoding")[] = ['places', 'geocoding'];

interface Location {
  address: string;
  lat: number;
  lng: number;
}

type PriorityType = 'time' | 'distance' | 'balanced';

interface RouteInfo {
  distance: string;
  duration: string;
  order: number[];
  legs: Array<{
    distance: string;
    duration: string;
    startLocation: Location;
    endLocation: Location;
  }>;
}

function topologicalSort(nodes: number[], dependencies: Record<number, number | null>): number[] | null {
  const inDegree: Record<number, number> = {};
  const adj: Record<number, number[]> = {};
  nodes.forEach((n) => {
    inDegree[n] = 0;
    adj[n] = [];
  });
  Object.entries(dependencies).forEach(([to, from]) => {
    if (from !== null && from !== undefined && adj[from]) {
      adj[from].push(Number(to));
      inDegree[Number(to)]++;
    }
  });
  const queue = nodes.filter((n) => inDegree[n] === 0);
  const result: number[] = [];
  while (queue.length) {
    const node = queue.shift()!;
    result.push(node);
    adj[node].forEach((neighbor) => {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) queue.push(neighbor);
    });
  }
  return result.length === nodes.length ? result : null;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error('Error caught by boundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', textAlign: 'center' }}>
          <h1>Something went wrong</h1>
          <p>Please refresh the page or try again later</p>
        </div>
      );
    }

    return this.props.children;
  }
}

function App() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null);
  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null);
  const [newAddress, setNewAddress] = useState('');
  const [priority, setPriority] = useState<PriorityType>('balanced');
  const [startLocation, setStartLocation] = useState<Location | null>(null);
  const [userLocation, setUserLocation] = useState<Location | null>(null);
  const [isLoadingLocation, setIsLoadingLocation] = useState(true);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const [selectedLeg, setSelectedLeg] = useState<number | null>(null);
  const [dependencies, setDependencies] = useState<Record<number, number | null>>({});

  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: process.env.REACT_APP_GOOGLE_MAPS_API_KEY || '',
    libraries: libraries
  });

  useEffect(() => {
    // Get user's current location
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords;
          console.log('Konum koordinatları:', { latitude, longitude });
          
          // Create a simple address string from coordinates
          const address = `Konum (${latitude.toFixed(6)}, ${longitude.toFixed(6)})`;
          
          const locationData = {
            address,
            lat: latitude,
            lng: longitude
          };

          setUserLocation(locationData);
          setStartLocation(locationData);
          setIsLoadingLocation(false);
        },
        (error) => {
          console.error('Error getting location:', error);
          setIsLoadingLocation(false);
        }
      );
    } else {
      console.error('Geolocation is not supported by this browser.');
      setIsLoadingLocation(false);
    }
  }, []);

  const onLoad = useCallback((map: google.maps.Map) => {
    // Map is used in the GoogleMap component
  }, []);

  const onUnmount = useCallback(() => {
    // Map cleanup
  }, []);

  const onLoadAutocomplete = useCallback((autocomplete: google.maps.places.Autocomplete) => {
    autocompleteRef.current = autocomplete;
  }, []);

  const onPlaceChanged = () => {
    if (autocompleteRef.current) {
      const place = autocompleteRef.current.getPlace();
      if (place.geometry?.location) {
        const lat = place.geometry.location.lat();
        const lng = place.geometry.location.lng();
        const address = place.formatted_address || '';
        setLocations([...locations, { address, lat, lng }]);
        setNewAddress('');
      }
    }
  };

  const handlePriorityChange = (event: SelectChangeEvent) => {
    setPriority(event.target.value as PriorityType);
  };

  const handleDeleteLocation = (idx: number) => {
    setLocations((prev) => prev.filter((_, i) => i !== idx));
    setDependencies((prev) => {
      const newDeps: Record<number, number | null> = {};
      Object.entries(prev).forEach(([k, v]) => {
        const key = Number(k);
        if (key !== idx) {
          newDeps[key > idx ? key - 1 : key] = v !== null && v > idx ? v - 1 : v === idx ? null : v;
        }
      });
      return newDeps;
    });
  };

  const handleDependencyChange = (idx: number, event: SelectChangeEvent<number>) => {
    const value = event.target.value as number;
    setDependencies((prev) => ({ ...prev, [idx]: value === -1 ? null : value }));
  };

  const optimizeRoute = async () => {
    if (locations.length < 2 || !startLocation) return;

    // Get all possible destination indices that have no dependencies
    const indices = locations.map((_, i) => i);
    const possibleDestinations = indices.filter(idx => {
      // Bağımlı adresi yoksa (dependencies[idx] == null)
      return !Object.values(dependencies).includes(idx);
    });
    let bestResult: google.maps.DirectionsResult | null = null;
    let bestDistance = Infinity;
    let bestOrder: number[] = [];
    let bestLegs: any[] = [];

    for (let i of possibleDestinations) {
      // Topological sort for this destination
      const nodes = indices.filter((idx) => idx !== i);
      const topoOrder = topologicalSort(nodes, dependencies);
      if (!topoOrder) continue; // skip if not possible
      const order = [i, ...topoOrder]; // destination first, then rest
      // Directions API expects waypoints in order (excluding destination)
      const waypoints = order.slice(1).map(idx => ({
        location: { lat: locations[idx].lat, lng: locations[idx].lng },
        stopover: true
      }));
      try {
        const directionsService = new google.maps.DirectionsService();
        const result = await directionsService.route({
          origin: { lat: startLocation.lat, lng: startLocation.lng },
          destination: { lat: locations[i].lat, lng: locations[i].lng },
          waypoints: waypoints,
          optimizeWaypoints: false, // order is fixed by us
          travelMode: google.maps.TravelMode.DRIVING,
          drivingOptions: {
            departureTime: new Date(),
            trafficModel: priority === 'time' ? google.maps.TrafficModel.BEST_GUESS : undefined
          }
        });
        if (result.routes[0]) {
          const route = result.routes[0];
          const distance = route.legs.reduce((total, leg) => total + (leg.distance?.value || 0), 0);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestResult = result;
            bestOrder = order;
            bestLegs = route.legs;
          }
        }
      } catch (error) {
        console.error('Error calculating route:', error);
      }
    }

    if (bestResult) {
      setDirections(bestResult);
      setRouteInfo({
        distance: bestResult.routes[0].legs.reduce((total, leg) => total + (leg.distance?.text || ''), ''),
        duration: bestResult.routes[0].legs.reduce((total, leg) => total + (leg.duration?.text || ''), ''),
        order: bestOrder,
        legs: bestLegs
      });
    }
  };

  const handleUseCurrentLocation = () => {
    if (userLocation) {
      setStartLocation(userLocation);
    }
  };

  const openInGoogleMaps = () => {
    if (directions) {
      const origin = directions.routes[0].legs[0].start_location;
      const destination = directions.routes[0].legs[directions.routes[0].legs.length - 1].end_location;
      const waypoints = directions.routes[0].legs.slice(1, -1).map(leg => leg.start_location);
      
      const waypointsStr = waypoints.map(wp => `${wp.lat()},${wp.lng()}`).join('/');
      const url = `https://www.google.com/maps/dir/?api=1&origin=${origin.lat()},${origin.lng()}&destination=${destination.lat()},${destination.lng()}&waypoints=${waypointsStr}`;
      window.open(url, '_blank');
    }
  };

  const goToDestination = (from: { lat: number, lng: number }, to: { lat: number, lng: number }) => {
    const url = `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}`;
    window.open(url, '_blank');
  };

  if (loadError) {
    return <div>Error loading Google Maps: {loadError.message}</div>;
  }

  if (!isLoaded) {
    return <div>Loading...</div>;
  }

  return (
    <ErrorBoundary>
      <Container maxWidth="lg">
        <Box sx={{ my: 4 }}>
          <Typography variant="h4" component="h1" gutterBottom>
            Kurye Rota Optimizasyonu
          </Typography>
          
          <Paper sx={{ p: 2, mb: 2 }}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 2 }}>
              <Typography variant="h6">Başlangıç Noktası</Typography>
              {isLoadingLocation ? (
                <Typography>Konumunuz yükleniyor...</Typography>
              ) : (
                <>
                  {userLocation && (
                    <>
                      <Button
                        variant="outlined"
                        onClick={handleUseCurrentLocation}
                        sx={{ mb: 2 }}
                      >
                        Mevcut Konumumu Kullan
                      </Button>
                      <Typography variant="body2" color="text.secondary">
                        Mevcut Konumunuz:
                      </Typography>
                      <Typography variant="body2">
                        Koordinatlar: {userLocation.lat.toFixed(6)}, {userLocation.lng.toFixed(6)}
                      </Typography>
                    </>
                  )}
                  {isLoaded && (
                    <Autocomplete
                      onLoad={onLoadAutocomplete}
                      onPlaceChanged={onPlaceChanged}
                    >
                      <TextField
                        fullWidth
                        label="Adres Ekle"
                        value={newAddress}
                        onChange={(e) => setNewAddress(e.target.value)}
                        variant="outlined"
                      />
                    </Autocomplete>
                  )}
                </>
              )}
            </Box>

            {/* Address list just below the input */}
            <Box sx={{ mt: 2 }}>
              <Typography variant="h6" gutterBottom>
                Teslimat Noktaları:
              </Typography>
              {locations.map((location, idx) => (
                <Box key={idx} sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                  <Typography variant="body1" sx={{ flex: 1 }}>
                    {idx + 1}. {location.address}
                  </Typography>
                  <FormControl size="small" sx={{ minWidth: 180, mr: 1 }}>
                    <InputLabel>Alınması gereken adres</InputLabel>
                    <Select
                      value={dependencies[idx] ?? -1}
                      label="Alınması gereken adres"
                      onChange={(e) => handleDependencyChange(idx, e)}
                    >
                      <MenuItem value={-1}>Yok</MenuItem>
                      {locations.map((loc, depIdx) =>
                        depIdx !== idx ? (
                          <MenuItem key={depIdx} value={depIdx}>
                            {depIdx + 1}. {loc.address}
                          </MenuItem>
                        ) : null
                      )}
                    </Select>
                  </FormControl>
                  <IconButton onClick={() => handleDeleteLocation(idx)} size="small" color="error">
                    <DeleteIcon />
                  </IconButton>
                </Box>
              ))}
            </Box>

            <FormControl fullWidth>
              <InputLabel>Optimizasyon Önceliği</InputLabel>
              <Select
                value={priority}
                label="Optimizasyon Önceliği"
                onChange={handlePriorityChange}
              >
                <MenuItem value="time">Zaman (Trafik Verilerini Dikkate Alır)</MenuItem>
                <MenuItem value="distance">Mesafe</MenuItem>
                <MenuItem value="balanced">Dengeli</MenuItem>
              </Select>
            </FormControl>
          </Paper>
          
          <Button
            variant="contained"
            color="primary"
            onClick={optimizeRoute}
            disabled={locations.length < 2 || !startLocation}
            sx={{ mb: 2 }}
          >
            Rotayı Optimize Et
          </Button>
        </Box>

        {isLoaded ? (
          <GoogleMap
            mapContainerStyle={containerStyle}
            center={startLocation ? { lat: startLocation.lat, lng: startLocation.lng } : center}
            zoom={12}
            onLoad={onLoad}
            onUnmount={onUnmount}
          >
            {startLocation && (
              <Marker
                position={{ lat: startLocation.lat, lng: startLocation.lng }}
                label="S"
                icon={{
                  url: "http://maps.google.com/mapfiles/ms/icons/green-dot.png"
                }}
              />
            )}
            {locations.map((location, index) => (
              <Marker
                key={index}
                position={{ lat: location.lat, lng: location.lng }}
                label={(index + 1).toString()}
              />
            ))}
            {directions && <DirectionsRenderer directions={directions} />}
            
            {routeInfo && selectedLeg !== null && (
              <InfoWindow
                position={{
                  lat: (routeInfo.legs[selectedLeg].startLocation.lat + routeInfo.legs[selectedLeg].endLocation.lat) / 2,
                  lng: (routeInfo.legs[selectedLeg].startLocation.lng + routeInfo.legs[selectedLeg].endLocation.lng) / 2
                }}
                onCloseClick={() => setSelectedLeg(null)}
              >
                <div>
                  <p>Mesafe: {routeInfo.legs[selectedLeg].distance}</p>
                  <p>Süre: {routeInfo.legs[selectedLeg].duration}</p>
                </div>
              </InfoWindow>
            )}
          </GoogleMap>
        ) : (
          <Box>Loading...</Box>
        )}

        <Paper sx={{ p: 2, mt: 2 }}>
          <Typography variant="h6" gutterBottom>
            Başlangıç Noktası:
          </Typography>
          {startLocation && (
            <Typography variant="body1">
              {startLocation.address}
            </Typography>
          )}
          
          <Typography variant="h6" gutterBottom sx={{ mt: 2 }}>
            Teslimat Noktaları:
          </Typography>
          {locations.map((location, idx) => (
            <Box key={idx} sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
              <Typography variant="body1" sx={{ flex: 1 }}>
                {idx + 1}. {location.address}
              </Typography>
              <FormControl size="small" sx={{ minWidth: 180, mr: 1 }}>
                <InputLabel>Alınması gereken adres</InputLabel>
                <Select
                  value={dependencies[idx] ?? -1}
                  label="Alınması gereken adres"
                  onChange={(e) => handleDependencyChange(idx, e)}
                >
                  <MenuItem value={-1}>Yok</MenuItem>
                  {locations.map((loc, depIdx) =>
                    depIdx !== idx ? (
                      <MenuItem key={depIdx} value={depIdx}>
                        {depIdx + 1}. {loc.address}
                      </MenuItem>
                    ) : null
                  )}
                </Select>
              </FormControl>
              <IconButton onClick={() => handleDeleteLocation(idx)} size="small" color="error">
                <DeleteIcon />
              </IconButton>
            </Box>
          ))}

          {routeInfo && (
            <>
              <Typography variant="h6" gutterBottom sx={{ mt: 2 }}>
                Rota Bilgileri:
              </Typography>
              <Typography variant="body1">
                Toplam Mesafe: {routeInfo.distance || 'Hesaplanıyor...'}
              </Typography>
              <Typography variant="body1">
                Toplam Süre: {routeInfo.duration || 'Hesaplanıyor...'}
              </Typography>

              <Button
                variant="contained"
                color="primary"
                onClick={openInGoogleMaps}
                sx={{ mt: 2, mb: 2 }}
              >
                Google Maps'te Aç
              </Button>

              <Typography variant="h6" gutterBottom sx={{ mt: 2 }}>
                Optimize Edilmiş Sıra ve Mesafeler:
              </Typography>
              <Box component="ol" sx={{ pl: 2 }}>
                {routeInfo.legs && routeInfo.legs.map((leg, i) => (
                  <Box key={i} component="li" sx={{ mb: 2, display: 'flex', alignItems: 'center' }}>
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="body1">
                        {i === 0 ? `Başlangıç: ${leg.startLocation?.address || 'Bilinmeyen Konum'}` : `${i + 1}. ${leg.startLocation?.address || 'Bilinmeyen Konum'}`}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ pl: 2 }}>
                        → {leg.distance || 'Hesaplanıyor...'} ({leg.duration || 'Hesaplanıyor...'})
                      </Typography>
                      <Typography variant="body1" sx={{ mt: 1 }}>
                        {`Varış: ${leg.endLocation?.address || 'Bilinmeyen Konum'}`}
                      </Typography>
                    </Box>
                    <Button
                      variant="outlined"
                      size="small"
                      sx={{ ml: 2 }}
                      onClick={() => leg.startLocation && leg.endLocation && goToDestination(leg.startLocation, leg.endLocation)}
                    >
                      Go to this destination
                    </Button>
                  </Box>
                ))}
              </Box>
            </>
          )}
        </Paper>
      </Container>
    </ErrorBoundary>
  );
}

export default App; 