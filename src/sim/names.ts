/** Fictional name generator. Names are random combinations of common US given names and surnames. */
import type { Demo } from '../data/types';
import { Rng } from './rng';

const FIRST_M = ['James', 'Robert', 'John', 'Michael', 'David', 'William', 'Richard', 'Joseph', 'Thomas', 'Charles', 'Christopher', 'Daniel', 'Matthew', 'Anthony', 'Mark', 'Donald', 'Steven', 'Paul', 'Andrew', 'Joshua', 'Kenneth', 'Kevin', 'Brian', 'George', 'Timothy', 'Ronald', 'Edward', 'Jason', 'Jeffrey', 'Ryan', 'Jacob', 'Gary', 'Nicholas', 'Eric', 'Jonathan', 'Stephen', 'Larry', 'Justin', 'Scott', 'Brandon', 'Benjamin', 'Samuel', 'Gregory', 'Alexander', 'Patrick', 'Frank', 'Raymond', 'Jack', 'Dennis', 'Jerry', 'Tyler', 'Aaron', 'Henry', 'Douglas', 'Peter', 'Adam', 'Nathan', 'Zachary', 'Walter', 'Kyle', 'Harold', 'Carl', 'Jeremy', 'Keith', 'Roger', 'Gerald', 'Ethan', 'Arthur', 'Terry', 'Christian', 'Sean', 'Lawrence', 'Austin', 'Joe', 'Noah', 'Jesse', 'Albert', 'Bryan', 'Billy', 'Bruce', 'Willie', 'Jordan', 'Dylan', 'Alan', 'Ralph', 'Gabriel', 'Roy', 'Juan', 'Wayne', 'Eugene', 'Logan', 'Randy', 'Louis', 'Russell', 'Vincent', 'Philip', 'Bobby', 'Johnny', 'Bradley'];
const FIRST_F = ['Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica', 'Sarah', 'Karen', 'Lisa', 'Nancy', 'Betty', 'Sandra', 'Margaret', 'Ashley', 'Kimberly', 'Emily', 'Donna', 'Michelle', 'Carol', 'Amanda', 'Melissa', 'Deborah', 'Stephanie', 'Dorothy', 'Rebecca', 'Sharon', 'Laura', 'Cynthia', 'Amy', 'Kathleen', 'Angela', 'Shirley', 'Brenda', 'Emma', 'Anna', 'Pamela', 'Nicole', 'Samantha', 'Katherine', 'Christine', 'Helen', 'Debra', 'Rachel', 'Carolyn', 'Janet', 'Maria', 'Catherine', 'Heather', 'Diane', 'Olivia', 'Julie', 'Joyce', 'Victoria', 'Ruth', 'Virginia', 'Lauren', 'Kelly', 'Christina', 'Joan', 'Evelyn', 'Judith', 'Andrea', 'Hannah', 'Megan', 'Cheryl', 'Jacqueline', 'Martha', 'Madison', 'Teresa', 'Gloria', 'Sara', 'Janice', 'Ann', 'Kathryn', 'Abigail', 'Sophia', 'Frances', 'Jean', 'Alice', 'Judy', 'Isabella', 'Julia', 'Grace', 'Amber', 'Denise', 'Danielle', 'Marilyn', 'Beverly', 'Charlotte', 'Natalie', 'Theresa', 'Diana', 'Brittany', 'Doris', 'Kayla', 'Alexis', 'Lori', 'Marie'];
const FIRST_HISP_M = ['Jose', 'Luis', 'Carlos', 'Juan', 'Miguel', 'Jorge', 'Alejandro', 'Ricardo', 'Eduardo', 'Javier', 'Fernando', 'Roberto', 'Raul', 'Hector', 'Victor', 'Mario', 'Rafael', 'Oscar', 'Sergio', 'Ramon'];
const FIRST_HISP_F = ['Maria', 'Ana', 'Rosa', 'Carmen', 'Lucia', 'Sofia', 'Isabel', 'Elena', 'Gabriela', 'Adriana', 'Veronica', 'Patricia', 'Yolanda', 'Alejandra', 'Marisol', 'Daniela', 'Leticia', 'Claudia', 'Mariana', 'Guadalupe'];
const FIRST_ASIAN_M = ['Kevin', 'David', 'Daniel', 'Andrew', 'Eric', 'Raj', 'Vikram', 'Wei', 'Jun', 'Minh', 'Hiroshi', 'Sanjay', 'Arun', 'Kenji', 'Tuan'];
const FIRST_ASIAN_F = ['Grace', 'Michelle', 'Jennifer', 'Priya', 'Mei', 'Linh', 'Anjali', 'Yuki', 'Christine', 'Sunita', 'Hana', 'Jasmine', 'Lily', 'Neha', 'Ji-woo'];

const LAST_GENERAL = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Martin', 'Jackson', 'Thompson', 'White', 'Harris', 'Clark', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Hill', 'Green', 'Adams', 'Baker', 'Nelson', 'Carter', 'Mitchell', 'Roberts', 'Turner', 'Phillips', 'Campbell', 'Parker', 'Evans', 'Edwards', 'Collins', 'Stewart', 'Morris', 'Murphy', 'Cook', 'Rogers', 'Morgan', 'Cooper', 'Peterson', 'Bailey', 'Reed', 'Kelly', 'Howard', 'Cox', 'Ward', 'Richardson', 'Watson', 'Brooks', 'Wood', 'James', 'Bennett', 'Gray', 'Hughes', 'Price', 'Sanders', 'Myers', 'Long', 'Ross', 'Foster', 'Powell', 'Jenkins', 'Perry', 'Russell', 'Sullivan', 'Bell', 'Coleman', 'Butler', 'Henderson', 'Barnes', 'Fisher', 'Vasquez', 'Simmons', 'Graham', 'Marshall', 'Owens', 'Harrison', 'Gibson', 'Ellis', 'McDonald', 'Kennedy', 'Wells', 'Hayes', 'Hunt', 'Stone', 'Hamilton', 'Ford', 'Wagner', 'Schmidt', 'Meyer', 'Weber', 'Becker', 'Schultz', 'Hoffman', 'Koch', 'Olson', 'Larson', 'Hansen', 'Nielsen', 'Lindgren', 'Novak', 'Kowalski', 'Nowak', 'Ricci', 'Russo', 'Romano', 'Marino', 'Costa', 'Brennan', 'Doyle', "O'Brien", 'Flynn', 'Quinn', 'Gallagher', 'Burke', 'Walsh', 'Byrne', 'Callahan', 'Holt', 'Barrett', 'Crawford', 'Dunn', 'Hale', 'Harper', 'Lowe', 'Mercer', 'Pruitt', 'Sutton', 'Whitaker', 'Yates', 'Caldwell', 'Dalton', 'Fletcher', 'Garrison', 'Hartman', 'Lyons', 'Maddox', 'Prescott', 'Rhodes', 'Sawyer', 'Tate', 'Vaughn', 'Wheeler'];
const LAST_BLACK = ['Washington', 'Jefferson', 'Booker', 'Banks', 'Jackson', 'Robinson', 'Harris', 'Coleman', 'Freeman', 'Mosley', 'Wiggins', 'Dorsey', 'Battle', 'Gaines', 'Hairston', 'Pettaway', 'Toussaint', 'Okafor', 'Mensah', 'Diallo', 'Simmons', 'Brooks', 'Holmes', 'Ware', 'Bynum'];
const LAST_HISP = ['Garcia', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Perez', 'Sanchez', 'Ramirez', 'Torres', 'Flores', 'Rivera', 'Gomez', 'Diaz', 'Reyes', 'Morales', 'Cruz', 'Ortiz', 'Gutierrez', 'Chavez', 'Ramos', 'Ruiz', 'Alvarez', 'Mendoza', 'Castillo', 'Jimenez', 'Moreno', 'Romero', 'Herrera', 'Medina', 'Aguilar', 'Vargas', 'Castro', 'Guerrero', 'Delgado', 'Salazar', 'Navarro', 'Cortez', 'Espinoza', 'Valdez'];
const LAST_ASIAN = ['Nguyen', 'Kim', 'Lee', 'Patel', 'Chen', 'Wang', 'Li', 'Tran', 'Le', 'Park', 'Singh', 'Shah', 'Kumar', 'Wong', 'Yang', 'Liu', 'Huang', 'Zhang', 'Pham', 'Choi', 'Tanaka', 'Nakamura', 'Desai', 'Reddy', 'Cho', 'Lin', 'Wu', 'Ho', 'Yamamoto', 'Gupta'];

export type Gender = 'M' | 'F';
export interface GeneratedName {
  first: string;
  last: string;
  gender: Gender;
}

/** Generate a name with surname origin weighted by local demographics. */
export function generateName(rng: Rng, d?: Demo): GeneratedName {
  const gender: Gender = rng.chance(0.5) ? 'M' : 'F';
  const w = d ? [Math.max(d.white, 0.05), Math.max(d.black, 0.01), Math.max(d.hispanic, 0.01), Math.max(d.asian, 0.01)] : [0.6, 0.12, 0.18, 0.06];
  const group = rng.weighted(['white', 'black', 'hisp', 'asian'] as const, w);
  let first: string, last: string;
  if (group === 'hisp') {
    first = rng.pick(gender === 'M' ? (rng.chance(0.6) ? FIRST_HISP_M : FIRST_M) : rng.chance(0.6) ? FIRST_HISP_F : FIRST_F);
    last = rng.pick(LAST_HISP);
  } else if (group === 'asian') {
    first = rng.pick(gender === 'M' ? FIRST_ASIAN_M : FIRST_ASIAN_F);
    last = rng.pick(LAST_ASIAN);
  } else if (group === 'black') {
    first = rng.pick(gender === 'M' ? FIRST_M : FIRST_F);
    last = rng.pick(rng.chance(0.5) ? LAST_BLACK : LAST_GENERAL);
  } else {
    first = rng.pick(gender === 'M' ? FIRST_M : FIRST_F);
    last = rng.pick(LAST_GENERAL);
  }
  return { first, last, gender };
}
