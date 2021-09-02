import React, { useEffect, useRef, useState } from 'react';
import _ from 'lodash';
import { Block } from 'baseui/block';
import { useSnackbar, DURATION } from 'baseui/snackbar';
import { Check } from 'baseui/icon';
import { BsUpload } from 'react-icons/all';

import { createGeneration, Generation, Genome, Percentage, Probability, select } from '../../libs/genetic';
import { CarsLossType, CarsInProgressType } from './PopulationTable';
import { CarLicencePlateType, CarsType, CarType } from '../world/types/car';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_GENERATION_LIFETIME,
  DEFAULT_GENERATION_SIZE,
  DEFAULT_LONG_LIVING_CHAMPIONS_PERCENTAGE,
  DEFAULT_MUTATION_PROBABILITY,
  SECOND,
} from './EvolutionBoardParams';
import { carLossToFitness, GENOME_LENGTH } from '../../libs/carGenetic';
import {
  generateWorldVersion,
  generationToCars, loadGenerationFromStorage,
  removeGenerationFromStorage,
  saveGenerationToStorage
} from './utils/evolution';
import { deleteSearchParam, getFloatSearchParam, getIntSearchParam, setSearchParam } from '../../utils/url';
import EvolutionAnalytics from './EvolutionAnalytics';
import { loggerBuilder } from '../../utils/logger';
import ParkingAutomatic from '../world/parkings/ParkingAutomatic';
import World from '../world/World';
import { FITNESS_ALPHA } from './constants/evolution';

const GENERATION_SIZE_URL_PARAM = 'generation';
const GROUP_SIZE_URL_PARAM = 'group';
const GENERATION_LIFETIME_URL_PARAM = 'lifetime';
const MUTATION_PROBABILITY_URL_PARAM = 'mutation';
const LONG_LIVING_CHAMPIONS_URL_PARAM = 'champions';

//  Genome array, concatenated to a string (i.e. '1010011')
type GenomeKey = string;

type GenomeLossType = Record<GenomeKey, number | null>;

function EvolutionTabEvolution() {
  const {enqueue} = useSnackbar();

  const [worldIndex, setWorldIndex] = useState<number>(0);

  const [generationSize, setGenerationSize] = useState<number>(
    getIntSearchParam(GENERATION_SIZE_URL_PARAM, DEFAULT_GENERATION_SIZE)
  );
  const [restoredFromGenerationIndex, setRestoredFromGenerationIndex] = useState<number | null>(null);
  const [generationIndex, setGenerationIndex] = useState<number | null>(null);
  const [generation, setGeneration] = useState<Generation>([]);
  const [generationLifetime, setGenerationLifetime] = useState<number>(
    getIntSearchParam(GENERATION_LIFETIME_URL_PARAM, DEFAULT_GENERATION_LIFETIME)
  );

  const [cars, setCars] = useState<CarsType>({});
  const [carsBatch, setCarsBatch] = useState<CarType[]>([]);
  const [carsBatchSize, setCarsBatchSize] = useState<number>(
    getIntSearchParam(GROUP_SIZE_URL_PARAM, DEFAULT_BATCH_SIZE)
  );
  const [carsBatchIndex, setCarsBatchIndex] = useState<number | null>(null);
  const carsRef = useRef<CarsType>({});

  const [bestGenome, setBestGenome] = useState<Genome | null>(null);
  const [minLoss, setMinLoss] = useState<number | null>(null);
  const [bestCarLicencePlate, setBestCarLicencePlate] = useState<CarLicencePlateType | null>(null);
  const [secondBestGenome, setSecondBestGenome] = useState<Genome | null>(null);
  const [secondMinLoss, setSecondMinLoss] = useState<number | null>(null);
  const [secondBestCarLicencePlate, setSecondBestCarLicencePlate] = useState<CarLicencePlateType | null>(null);

  const batchTimer = useRef<NodeJS.Timeout | null>(null);

  const carsLossRef = useRef<CarsLossType[]>([{}]);
  const [carsLoss, setCarsLoss] = useState<CarsLossType[]>([{}]);
  const [lossHistory, setLossHistory] = useState<number[]>([]);
  const [avgLossHistory, setAvgLossHistory] = useState<number[]>([]);
  const genomeLossRef = useRef<GenomeLossType[]>([{}]);

  const [mutationProbability, setMutationProbability] = useState<Probability>(
    getFloatSearchParam(MUTATION_PROBABILITY_URL_PARAM, DEFAULT_MUTATION_PROBABILITY)
  );
  const [longLivingChampionsPercentage, setLongLivingChampionsPercentage] = useState<Percentage>(
    getIntSearchParam(LONG_LIVING_CHAMPIONS_URL_PARAM, DEFAULT_LONG_LIVING_CHAMPIONS_PERCENTAGE)
  );

  const logger = loggerBuilder({ context: 'EvolutionTab' });
  const carsBatchesTotal: number = Math.ceil(Object.keys(cars).length / carsBatchSize);
  const carsInProgress: CarsInProgressType = carsBatch.reduce((cars: CarsInProgressType, car: CarType) => {
    cars[car.licencePlate] = true;
    return cars;
  }, {});
  const batchVersion = generateWorldVersion(generationIndex, carsBatchIndex);
  const generationLifetimeMs = generationLifetime * SECOND;

  const onCommonStateReset = () => {
    setGeneration([]);
    setCarsBatch([]);
    setCars({});
    setCarsLoss([{}]);
    carsRef.current = {};
    carsLossRef.current = [{}];
    genomeLossRef.current = [{}];
    setLossHistory([]);
    setAvgLossHistory([]);
    setBestGenome(null);
    setMinLoss(null);
    setBestCarLicencePlate(null);
    setSecondBestGenome(null);
    setSecondMinLoss(null);
    setSecondBestCarLicencePlate(null);
  };

  const onEvolutionRestart = () => {
    cancelBatchTimer();
    onCommonStateReset();
    setWorldIndex(worldIndex + 1);
    setGenerationIndex(0);
    setCarsBatchIndex(null);
    removeGenerationFromStorage();
  };

  const onCarLossUpdate = (licensePlate: CarLicencePlateType, loss: number) => {
    if (generationIndex === null) {
      return;
    }

    // Save the car loss to the "LicencePlate → Loss" map.
    if (!carsLossRef.current[generationIndex]) {
      carsLossRef.current[generationIndex] = {};
    }
    carsLossRef.current[generationIndex][licensePlate] = loss;

    // Save the car loss to the "GenomeKey → Loss" map.
    if (!genomeLossRef.current[generationIndex]) {
      genomeLossRef.current[generationIndex] = {};
    }
    if (carsRef.current[licensePlate]) {
      const carGenomeIndex = carsRef.current[licensePlate].genomeIndex;
      const carGenome: Genome = generation[carGenomeIndex];
      const carGenomeKey: GenomeKey = carGenome.join('');
      genomeLossRef.current[generationIndex][carGenomeKey] = loss;
    }
  };

  const onGenerationSizeChange = (size: number) => {
    setGenerationSize(size);
    setSearchParam(GENERATION_SIZE_URL_PARAM, `${size}`);
    onEvolutionRestart();
  };

  const onSetDefaultFilterValues = () => {
    deleteSearchParam(GENERATION_SIZE_URL_PARAM);
    deleteSearchParam(GROUP_SIZE_URL_PARAM);
    deleteSearchParam(GENERATION_LIFETIME_URL_PARAM);
    deleteSearchParam(MUTATION_PROBABILITY_URL_PARAM);
    deleteSearchParam(LONG_LIVING_CHAMPIONS_URL_PARAM);

    setGenerationSize(DEFAULT_GENERATION_SIZE);
    setCarsBatchSize(DEFAULT_BATCH_SIZE);
    setGenerationLifetime(DEFAULT_GENERATION_LIFETIME);
    setMutationProbability(DEFAULT_MUTATION_PROBABILITY);
    setLongLivingChampionsPercentage(DEFAULT_LONG_LIVING_CHAMPIONS_PERCENTAGE);
  };

  const onReset = () => {
    onSetDefaultFilterValues();
    onEvolutionRestart();
    enqueue({
      message: 'Evolution setup and training progress have been reset',
      startEnhancer: ({size}) => <Check size={size} />,
    }, DURATION.medium);
  };

  const onMutationProbabilityChange = (probability: Probability) => {
    setMutationProbability(probability);
    setSearchParam(MUTATION_PROBABILITY_URL_PARAM, `${probability}`);
  };

  const onLongLivingChampionsPercentageChange = (percentage: Percentage) => {
    setLongLivingChampionsPercentage(percentage);
    setSearchParam(LONG_LIVING_CHAMPIONS_URL_PARAM, `${percentage}`);
  };

  const onBatchSizeChange = (size: number) => {
    setCarsBatchSize(size);
    setSearchParam(GROUP_SIZE_URL_PARAM, `${size}`);
    onEvolutionRestart();
  };

  const onGenerationLifetimeChange = (time: number) => {
    setGenerationLifetime(time);
    setSearchParam(GENERATION_LIFETIME_URL_PARAM, `${time}`);
  };

  const cancelBatchTimer = () => {
    logger.info('Trying to cancel batch timer');
    if (batchTimer.current === null) {
      return;
    }
    clearTimeout(batchTimer.current);
    batchTimer.current = null;
  };

  const syncBestGenome = (): string | null | undefined => {
    if (generationIndex === null) {
      return;
    }

    const generationLoss: CarsLossType = carsLossRef.current[generationIndex];
    if (!generationLoss) {
      return;
    }

    let bestCarLicensePlate: CarLicencePlateType | null = null;
    let minLoss: number = Infinity;
    let bestGenomeIndex: number = -1;

    Object.keys(generationLoss).forEach((licencePlate: CarLicencePlateType) => {
      const carLoss: number | null = generationLoss[licencePlate];
      if (carLoss === null) {
        return;
      }
      if (carLoss < minLoss) {
        minLoss = carLoss;
        bestCarLicensePlate = licencePlate;
        bestGenomeIndex = cars[licencePlate].genomeIndex;
      }
    });

    if (bestGenomeIndex === -1) {
      return;
    }

    setMinLoss(minLoss);
    setBestGenome(generation[bestGenomeIndex]);
    setBestCarLicencePlate(bestCarLicensePlate);

    return bestCarLicensePlate;
  };

  const syncSecondBestGenome = (
    bestLicensePlateSoFar: string | null | undefined
  ): string | null | undefined => {
    if (generationIndex === null || !bestLicensePlateSoFar) {
      return;
    }

    const generationLoss: CarsLossType = carsLossRef.current[generationIndex];
    if (!generationLoss) {
      return;
    }

    let secondBestCarLicensePlate: CarLicencePlateType | null = null;
    let secondMinLoss: number = Infinity;
    let secondBestGenomeIndex: number = -1;

    Object.keys(generationLoss).forEach((licencePlate: CarLicencePlateType) => {
      // Skipping the best car genome.
      if (licencePlate === bestLicensePlateSoFar) {
        return;
      }
      const carLoss: number | null = generationLoss[licencePlate];
      if (carLoss === null) {
        return;
      }
      if (carLoss < secondMinLoss) {
        secondMinLoss = carLoss;
        secondBestCarLicensePlate = licencePlate;
        secondBestGenomeIndex = cars[licencePlate].genomeIndex;
      }
    });

    if (secondBestGenomeIndex === -1) {
      return;
    }

    setSecondMinLoss(secondMinLoss);
    setSecondBestGenome(generation[secondBestGenomeIndex]);
    setSecondBestCarLicencePlate(secondBestCarLicensePlate);

    return secondBestCarLicensePlate;
  };

  const syncLossHistory = () => {
    if (generationIndex === null) {
      return;
    }
    const generationLoss: CarsLossType = carsLossRef.current[generationIndex];

    // Sync min loss history.
    const newLossHistory = [...lossHistory];
    if (generationLoss) {
      newLossHistory[generationIndex] = Object.values(generationLoss).reduce(
        (minVal: number, currVal: number | null) => {
          if (currVal === null) {
            return minVal;
          }
          return Math.min(minVal, currVal);
        },
        Infinity
      );
    } else {
      newLossHistory[generationIndex] = Infinity;
    }
    setLossHistory(newLossHistory);

    // Sync avg loss history.
    const newAvgLossHistory = [...avgLossHistory];
    if (generationLoss) {
      let nonNullLosses = 0;

      const ascSortedGenerationLoss = Object.values<number | null>(generationLoss)
        .sort((a: number | null, b: number | null): number => {
          const aTuned: number = a === null ? Infinity : a;
          const bTuned: number = b === null ? Infinity : b;
          if (aTuned < bTuned) {
            return -1;
          }
          if (aTuned > bTuned) {
            return 1;
          }
          return 0;
        }
      );

      const p95GenerationLoss = ascSortedGenerationLoss.slice(
        0,
        Math.ceil(ascSortedGenerationLoss.length * 0.95),
      );

      const lossSum = p95GenerationLoss.reduce(
        (sum: number, currVal: number | null) => {
          if (currVal === null) {
            return sum;
          }
          nonNullLosses += 1;
          return sum + currVal;
        },
        0
      );
      newAvgLossHistory[generationIndex] = nonNullLosses ? lossSum / nonNullLosses : 0;
    } else {
      newAvgLossHistory[generationIndex] = Infinity;
    }
    setAvgLossHistory(newAvgLossHistory);
  };

  const carFitnessFunction = (generationIndex: number) => (genome: Genome): number => {
    const genomeKey = genome.join('');
    if (
      generationIndex === null ||
      !genomeLossRef.current[generationIndex] ||
      typeof genomeLossRef.current[generationIndex][genomeKey] !== 'number'
    ) {
      throw new Error('Fitness value for specified genome is undefined');
    }
    const loss = genomeLossRef.current[generationIndex][genomeKey];
    if (typeof loss !== 'number') {
      throw new Error('Loss value is not a number');
    }
    return carLossToFitness(loss, FITNESS_ALPHA);
  };

  const isValidGenerationFromStorage = (generation: Generation | null): boolean => {
    return !!(
      generation &&
      generation.length === generationSize &&
      generation[0].length === GENOME_LENGTH
    );
  };

  const getGenerationIndexFromStorage = (): number | null => {
    const {
      generation: generationFromStorage,
      generationIndex: generationIndexFromStorage,
    } = loadGenerationFromStorage();
    if (
      isValidGenerationFromStorage(generationFromStorage) &&
      generationIndexFromStorage
    ) {
      return generationIndexFromStorage;
    }
    return null;
  };

  const getLossHistoryFromStorage = (): number[] | null => {
    const {
      lossHistory: lossHistoryFromStorage,
      generation: generationFromStorage,
    } = loadGenerationFromStorage();
    if (
      isValidGenerationFromStorage(generationFromStorage) &&
      lossHistoryFromStorage
    ) {
      return lossHistoryFromStorage;
    }
    return null;
  };

  const getAvgLossHistoryFromStorage = (): number[] | null => {
    const {
      avgLossHistory: avgLossHistoryFromStorage,
      generation: generationFromStorage,
    } = loadGenerationFromStorage();
    if (
      isValidGenerationFromStorage(generationFromStorage) &&
      avgLossHistoryFromStorage
    ) {
      return avgLossHistoryFromStorage;
    }
    return null;
  };

  const getGenerationFromStorage = (): Generation | null => {
    const {
      generation: generationFromStorage,
    } = loadGenerationFromStorage();
    if (isValidGenerationFromStorage(generationFromStorage)) {
      return generationFromStorage;
    }
    if (generationFromStorage) {
      try {
        const debugGenerationSize = generationFromStorage.length;
        const debugGenomeLength = generationFromStorage[0].length;
        logger.warn(`Generation from storage is invalid: generation size ${debugGenerationSize}, genome length ${debugGenomeLength}`);
      } catch (err) {
        logger.warn('Generation from storage is invalid');
      }
    }
    return null;
  };

  const startEvolution = () => {
    logger.info('Start evolution');
    let generationStartIndex = 0;

    const generationIndexFromStorage = getGenerationIndexFromStorage();
    const lossHistoryFromStorage = getLossHistoryFromStorage();
    const avgLossHistoryFromStorage = getAvgLossHistoryFromStorage();

    if (generationIndexFromStorage && lossHistoryFromStorage && avgLossHistoryFromStorage) {
      generationStartIndex = generationIndexFromStorage;
      setRestoredFromGenerationIndex(generationIndexFromStorage);
      setLossHistory(lossHistoryFromStorage);
      setAvgLossHistory(avgLossHistoryFromStorage);
    }

    setGenerationIndex(generationStartIndex);
  };

  const createFirstGeneration = () => {
    if (generationIndex === null) {
      return;
    }
    logger.info('Create first generation');
    let firstGeneration: Generation = createGeneration({
      generationSize,
      genomeLength: GENOME_LENGTH,
    });

    const generationFromStorage: Generation | null = getGenerationFromStorage();
    const generationIndexFromStorage: number | null = getGenerationIndexFromStorage();
    if (generationFromStorage && generationIndexFromStorage) {
      firstGeneration = generationFromStorage;
      enqueue({
        message:
          `Generation #${generationIndexFromStorage} has been restored from the saved checkpoint. To start from scratch, press the Reset button.`,
        startEnhancer: ({size}) => <BsUpload size={size} />,
      }, DURATION.medium);
    }

    setGeneration(firstGeneration);
    setBestGenome(firstGeneration[0]);
    setSecondBestGenome(firstGeneration[1]);
  };

  const mateExistingGeneration = () => {
    if (generationIndex === null) {
      return;
    }
    logger.info(`Mate generation #${generationIndex}`);
    try {
      const newGeneration = select(
        generation,
        carFitnessFunction(generationIndex - 1),
        {
          mutationProbability,
          longLivingChampionsPercentage: longLivingChampionsPercentage,
        },
      );
      setGeneration(newGeneration);
      saveGenerationToStorage({
        generation: newGeneration,
        generationIndex,
        lossHistory,
        avgLossHistory,
      });
    } catch (e) {
      // If selection failed for some reason, clone the existing generation and try again.
      setGeneration([...generation]);
      const errorMessage = 'The selection for the new generation has failed. Cloning the existing generation to try it next time.';
      const exceptionMessage = e && e.message ? e.message : '';
      logger.warn(errorMessage, exceptionMessage);
    }
  };

  const createCarsFromGeneration = () => {
    if (!generation || !generation.length) {
      return;
    }
    logger.info(`Create cars from generation #${generationIndex}`);
    const cars = generationToCars({
      generation,
      generationIndex,
      onLossUpdate: onCarLossUpdate,
    });
    setCars(cars);
    setCarsBatchIndex(0);
    carsRef.current = _.cloneDeep(cars);
  };

  const generateNextCarsBatch = () => {
    if (carsBatchIndex === null || generationIndex === null) {
      return;
    }
    if (!cars || !Object.keys(cars).length) {
      return;
    }
    if (carsBatchIndex >= carsBatchesTotal) {
      return;
    }
    logger.info(`Generate cars batch #${carsBatchIndex}`);
    const batchStart = carsBatchSize * carsBatchIndex;
    const batchEnd = batchStart + carsBatchSize;
    const carsBatch: CarType[] = Object.values(cars).slice(batchStart, batchEnd);
    setCarsBatch(carsBatch);
  };

  const onBatchLifetimeEnd = () => {
    if (carsBatchIndex === null) {
      return;
    }
    logger.info(`Batch #${carsBatchIndex} lifetime ended`);
    setCarsLoss(_.cloneDeep<CarsLossType[]>(carsLossRef.current));
    syncLossHistory();
    const bestLicensePlate = syncBestGenome();
    syncSecondBestGenome(bestLicensePlate);
    const nextBatchIndex = carsBatchIndex + 1;
    if (nextBatchIndex >= carsBatchesTotal) {
      setCarsBatch([]);
      if (generationIndex !== null) {
        setCarsBatchIndex(null);
        setGenerationIndex(generationIndex + 1);
      }
      return;
    }
    setCarsBatchIndex(nextBatchIndex);
  };

  const countDownBatchLifetime = (onLifetimeEnd: () => void) => {
    if (carsBatchIndex === null) {
      return;
    }
    if (!carsBatch || !carsBatch.length) {
      return;
    }
    logger.info(`Batch #${carsBatchIndex} lifetime started`);
    cancelBatchTimer();
    batchTimer.current = setTimeout(onLifetimeEnd, generationLifetimeMs);
  };

  // Start the evolution.
  useEffect(() => {
    startEvolution();
  }, []);

  // Once generation index is changed we need to create (or mate) a new generation.
  useEffect(() => {
    if (generationIndex === 0 || generationIndex === restoredFromGenerationIndex) {
      createFirstGeneration();
    } else {
      mateExistingGeneration();
    }
  }, [generationIndex, worldIndex]);

  // Once generation is changed we need to create cars.
  useEffect(() => {
    createCarsFromGeneration();
  }, [generation]);

  // Once the cars batch index is updated we need to generate a cars batch.
  useEffect(() => {
    generateNextCarsBatch();
  }, [carsBatchIndex]);

  // Once the new cars batch is created we need to start generation timer.
  useEffect(() => {
    countDownBatchLifetime(onBatchLifetimeEnd);
    return () => {
      cancelBatchTimer();
    };
  }, [carsBatch]);

  return (
    <Block>
      <World version={batchVersion}>
        <ParkingAutomatic
          cars={carsBatch}
          withVisibleSensors
          withLabels
        />
      </World>
      <EvolutionAnalytics
        mutationProbability={mutationProbability}
        onMutationProbabilityChange={onMutationProbabilityChange}
        longLivingChampionsPercentage={longLivingChampionsPercentage}
        generationIndex={generationIndex}
        carsBatchIndex={carsBatchIndex}
        totalBatches={carsBatchesTotal}
        worldIndex={worldIndex}
        generationLifetimeMs={generationLifetimeMs}
        generationSize={generationSize}
        carsBatchSize={carsBatchSize}
        generationLifetime={generationLifetime}
        batchVersion={batchVersion}
        onGenerationSizeChange={onGenerationSizeChange}
        onBatchSizeChange={onBatchSizeChange}
        onGenerationLifetimeChange={onGenerationLifetimeChange}
        onLongLivingChampionsPercentageChange={onLongLivingChampionsPercentageChange}
        onReset={onReset}
        lossHistory={lossHistory}
        avgLossHistory={avgLossHistory}
        cars={cars}
        carsInProgress={carsInProgress}
        carsLoss={carsLoss}
        bestGenome={bestGenome}
        bestCarLicencePlate={bestCarLicencePlate}
        minLoss={minLoss}
        secondBestGenome={secondBestGenome}
        secondBestCarLicencePlate={secondBestCarLicencePlate}
        secondMinLoss={secondMinLoss}
      />
    </Block>
  );
}

export default EvolutionTabEvolution;
