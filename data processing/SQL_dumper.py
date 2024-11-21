import pandas as pd
import json
from collections import defaultdict
from datetime import datetime
import numpy as np
import os
from sqlalchemy import create_engine, text


def load_and_clean_data(bills_path, legislators_path, bill_sponsors_path, 
                       bill_policies_path, bill_policy_links_path, target_congress=117):
    """
    Load and clean the raw data files, integrating policy information.
    """
    print("Loading data files...")
    # Load all data files
    bills_df = pd.read_csv(bills_path)
    legislators_df = pd.read_csv(legislators_path)
    bill_sponsors_df = pd.read_csv(bill_sponsors_path, low_memory=False)
    bill_policies_df = pd.read_csv(bill_policies_path)
    bill_policy_links_df = pd.read_csv(bill_policy_links_path)
    
    print("\nInitial data shapes:")
    print(f"Bills: {bills_df.shape}")
    print(f"Policy Links: {bill_policy_links_df.shape}")
    print(f"Policies: {bill_policies_df.shape}")
    
    print("Filtering by congress...")
    # Filter bills for target congress
    bills_df = bills_df[bills_df['congress'] >= target_congress].copy()
    
    # Sort by latest action date and keep most recent bills
    bills_df['latest_action_date'] = pd.to_datetime(
        bills_df['latest_action_date'], errors='coerce'
    )
    bills_df = bills_df.sort_values('latest_action_date', ascending=False)
    
    # Clean legislators data
    legislators_df['full_name'] = legislators_df.apply(
        lambda x: f"{x['first_name']} {x['last_name']}", axis=1
    )
    legislators_df['district'] = legislators_df['district'].fillna(-1).astype(int)
    legislators_df['party'] = legislators_df['party'].fillna('O')
    
    print("\nAdding policy information...")
    # First merge: bills with policy links
    bills_df = bills_df.merge(
        bill_policy_links_df,
        on='bill_number',
        how='left'
    )
    print("Columns after first merge:", bills_df.columns.tolist())
    
    # Second merge: add policy names
    bills_df = bills_df.merge(
        bill_policies_df.rename(columns={'name': 'policy_name'}),
        on='policy_id',
        how='left'
    )
    print("Columns after second merge:", bills_df.columns.tolist())
    
    # Format dates back to string for JSON
    bills_df['latest_action_date'] = bills_df['latest_action_date'].dt.strftime('%Y-%m-%d')
    
    print("\nMerge completion status:")
    print(f"Bills with policies: {len(bills_df)}")
    print(f"Unique policies: {bills_df['policy_name'].nunique()}")
    print(f"Sample policies: {bills_df['policy_name'].dropna().unique()[:5].tolist()}")
    
    return bills_df, legislators_df, bill_sponsors_df, bill_policies_df

    

def create_legislator_nodes(legislators_df):
    """
    Create the legislators array with essential information.
    """
    return [
        {
            'id': row['bioguide_id'],
            'name': row['full_name'],
            'state': row['state'],
            'district': int(row['district']) if row['district'] != -1 else None,
            'party': row['party'],
            'first_name': row['first_name'],
            'last_name': row['last_name']
        }
        for _, row in legislators_df.iterrows()
    ]

def process_bills(bills_df):
    """
    Create the bills array with essential information including policy data.
    """
    return [
        {
            'bill_number': row['bill_number'],
            'congress': row['congress'],
            'title': row['title'],
            'latest_action_date': row['latest_action_date'],
            'latest_action_text': row['latest_action_text'],
            'origin_chamber': row['origin_chamber'],
            'policy_id': row['policy_id'] if pd.notna(row['policy_id']) else None,
            'policy_name': row['policy_name'] if pd.notna(row['policy_name']) else 'Uncategorized'
        }
        for _, row in bills_df.iterrows()
    ]

def process_collaborations(bill_sponsors_df, bills_df):
    """
    Create the collaborations array focusing on primary sponsor relationships.
    """
    # Create bill info lookup
    bill_info = {}
    for _, row in bills_df.iterrows():
        bill_info[row['bill_number']] = {
            'congress': row['congress'],
            'title': row['title'],
            'latest_action_text': row['latest_action_text'],
            'latest_action_date': row['latest_action_date']
        }
    
    # First find primary sponsors
    primary_sponsors = bill_sponsors_df[
        bill_sponsors_df['sponsor_type'] == 'Primary'
    ].set_index('bill_number')['bioguide_id'].to_dict()
    
    # Count meaningful collaborations
    collaboration_counts = defaultdict(int)
    valid_bills = set(bill_info.keys())
    
    for bill_number, group in bill_sponsors_df[
        (bill_sponsors_df['bill_number'].isin(valid_bills)) &
        (bill_sponsors_df['sponsor_type'] == 'Cosponsor')
    ].groupby('bill_number'):
        if bill_number not in primary_sponsors:
            continue
            
        primary_sponsor = primary_sponsors[bill_number]
        cosponsors = group['bioguide_id'].tolist()
        
        # Connect primary sponsor to each cosponsor
        for cosponsor in cosponsors:
            pair = tuple(sorted([primary_sponsor, cosponsor]))
            collaboration_counts[pair] += 1
    
    # Filter to keep only significant collaborations
    min_collaborations = 2
    significant_pairs = {
        pair: count for pair, count in collaboration_counts.items()
        if count >= min_collaborations
    }
    
    print(f"Found {len(significant_pairs)} significant primary-cosponsor relationships")
    
    # Create detailed collaboration records
    collaborations = []
    
    for bill_number in valid_bills:
        if bill_number not in primary_sponsors:
            continue
            
        primary_sponsor = primary_sponsors[bill_number]
        cosponsors = bill_sponsors_df[
            (bill_sponsors_df['bill_number'] == bill_number) &
            (bill_sponsors_df['sponsor_type'] == 'Cosponsor')
        ]['bioguide_id'].tolist()
        
        bill_data = bill_info[bill_number]
        
        for cosponsor in cosponsors:
            pair = tuple(sorted([primary_sponsor, cosponsor]))
            if pair in significant_pairs:
                collaborations.append({
                    'source': pair[0],
                    'target': pair[1],
                    'bill_number': bill_number,
                    'congress': bill_data['congress'],
                    'title': bill_data['title'],
                    'latest_action': bill_data['latest_action_text'],
                    'action_date': bill_data['latest_action_date'],
                    'relationship': 'Primary-Cosponsor'
                })
    
    print(f"Generated {len(collaborations)} primary-cosponsor collaboration records")
    return collaborations

def calculate_sponsor_stats(legislators, collaborations):
    """
    Calculate sponsorship statistics for each legislator.
    """
    stats = defaultdict(lambda: {
        'primary_count': 0,
        'cosponsor_count': 0,
        'total_collaborations': 0,
        'party_collaborations': defaultdict(int)
    })
    
    # Create party lookup
    party_lookup = {leg['id']: leg['party'] for leg in legislators}
    
    for collab in collaborations:
        source_id = collab['source']
        target_id = collab['target']
        
        # Update source stats
        stats[source_id]['total_collaborations'] += 1
        stats[source_id]['party_collaborations'][party_lookup.get(target_id, 'O')] += 1
        
        # Update target stats
        stats[target_id]['total_collaborations'] += 1
        stats[target_id]['party_collaborations'][party_lookup.get(source_id, 'O')] += 1
    
    return dict(stats)

def convert_to_serializable(obj):
    """
    Convert numpy/pandas types to Python native types for JSON serialization.
    """
    if isinstance(obj, (np.int64, np.int32, np.int16, np.int8)):
        return int(obj)
    elif isinstance(obj, (np.float64, np.float32, np.float16)):
        return float(obj)
    elif isinstance(obj, dict):
        return {key: convert_to_serializable(value) for key, value in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [convert_to_serializable(item) for item in obj]
    elif isinstance(obj, np.bool_):
        return bool(obj)
    return obj

def prepare_network_data(bills_path, legislators_path, bill_sponsors_path, 
                        bill_policies_path, bill_policy_links_path, target_congress=117):
    """
    Prepare complete network data structure including policy information.
    """
    print("Loading and cleaning data...")
    bills_df, legislators_df, bill_sponsors_df, bill_policies_df = load_and_clean_data(
        bills_path, legislators_path, bill_sponsors_path,
        bill_policies_path, bill_policy_links_path, target_congress
    )
    
    print("Creating legislator nodes...")
    all_legislators = create_legislator_nodes(legislators_df)
    
    print("Processing bills...")
    bills = process_bills(bills_df)
    
    print("Processing collaborations...")
    collaborations = process_collaborations(bill_sponsors_df, bills_df)
    
    # Get active legislators and their metrics
    active_legislators = set()
    for collab in collaborations:
        active_legislators.add(collab['source'])
        active_legislators.add(collab['target'])
    
    legislators = [leg for leg in all_legislators if leg['id'] in active_legislators]
    
    print(f"Filtered to {len(legislators)} active legislators")
    
    print("Calculating metrics...")
    metrics = calculate_sponsor_stats(legislators, collaborations)
    
    # Add metrics to legislators
    for legislator in legislators:
        if legislator['id'] in metrics:
            legislator['metrics'] = metrics[legislator['id']]
    
    # Get policy information
    policies = [
        {
            'id': str(row['policy_id']),
            'name': row['name']
        }
        for _, row in bill_policies_df.iterrows()
    ]
    
    # Count bills per policy
    policy_counts = defaultdict(int)
    for bill in bills:
        policy_name = bill.get('policy_name', 'Uncategorized')
        if policy_name != 'Uncategorized':
            policy_counts[policy_name] += 1
    
    print("\nPolicy distribution:")
    print(f"Total policies found: {len(policy_counts)}")
    print("Top 5 policies by bill count:")
    for policy, count in sorted(policy_counts.items(), key=lambda x: x[1], reverse=True)[:5]:
        print(f"- {policy}: {count} bills")
    
    # Create metadata
    metadata = {
        'congress_range': {
        'start': int(min(bills_df['congress'])),
        'end': int(max(bills_df['congress']))
        },
        'total_bills': len(bills),
        'total_collaborations': len(collaborations),
        'total_legislators': len(legislators),
        'date_range': {
            'start': min(b['latest_action_date'] for b in bills),
            'end': max(b['latest_action_date'] for b in bills)
        },
        'party_distribution': legislators_df[
            legislators_df['bioguide_id'].isin(active_legislators)
        ]['party'].value_counts().to_dict(),
        'policies': {
            'total': len(policies),
            'counts': dict(policy_counts)
        },
        'date_generated': datetime.now().strftime('%Y-%m-%d')
    }
    
    # Add some debug prints
    print("\nDebug Information:")
    print(f"Number of policies: {len(policies)}")
    print("Sample policy names:", [p['name'] for p in policies[:5]])
    print("Sample bill policy names:", [b['policy_name'] for b in bills[:5]])
    
    return {
        'legislators': legislators,
        'bills': bills,
        'collaborations': collaborations,
        'policies': policies,
        'metadata': metadata
    }

def upload_to_database(network_data):
    """
    Upload the complete network data as a single JSON structure
    """
    try:
        # Create database connection
        db_params = {
            'user': os.getenv('DB_USER', 'rhopkins'),
            'password': os.getenv('DB_PASSWORD', 'hiphop'),
            'host': os.getenv('DB_HOST', 'localhost'),
            'port': os.getenv('DB_PORT', '5433'),
            'database': os.getenv('DB_NAME', 'PolicyPosse-DB')
        }
        
        connection_string = f"postgresql://{db_params['user']}:{db_params['password']}@{db_params['host']}:{db_params['port']}/{db_params['database']}"
        engine = create_engine(connection_string)
        
        print("\nUploading network data to database...")
        
        with engine.begin() as conn:
            # Create table - specify JSONB type in table creation
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS network_data (
                    id SERIAL PRIMARY KEY,
                    congress_range JSONB NOT NULL,
                    data JSONB NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """))
            
            # Convert data to serializable format
            serializable_data = convert_to_serializable(network_data)
            congress_range_json = json.dumps(network_data['metadata']['congress_range'])
            data_json = json.dumps(serializable_data)
            
            # Simple insert with pre-formatted JSON
            conn.execute(text("""
                INSERT INTO network_data (congress_range, data)
                VALUES (:congress_range, :data);
            """),
            {
                "congress_range": congress_range_json,
                "data": data_json
            })
            
        print("Network data successfully uploaded to database!")
        print(f"Congress Range: {network_data['metadata']['congress_range']}")
        print(f"Legislators: {len(network_data['legislators'])}")
        print(f"Bills: {len(network_data['bills'])}")
        print(f"Collaborations: {len(network_data['collaborations'])}")
        print(f"Policies: {len(network_data['policies'])}")
        
    except Exception as e:
        print(f"Error uploading to database: {str(e)}")
        raise

def main():
    """
    Modified main function to both save JSON and upload to database
    """
    bills_path = r'Data\congressional_data\bills.csv'
    legislators_path = r'Data\congressional_data\legislators.csv'
    bill_sponsors_path = r'Data\congressional_data\bill_sponsors.csv'
    bill_policies_path = r'Data\congressional_data\bill_policies.csv'
    bill_policy_links_path = r'Data\congressional_data\bill_policy_links.csv'
    
    try:
        # Generate network data using original function
        network_data = prepare_network_data(
            bills_path, 
            legislators_path, 
            bill_sponsors_path,
            bill_policies_path,
            bill_policy_links_path,
            target_congress=117
        )
        
        # Save to JSON (original functionality)
        print("\nSaving data to JSON file...")
        serializable_data = convert_to_serializable(network_data)
        with open('network_data_sql.json', 'w', encoding='utf-8') as f:
            json.dump(serializable_data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        
        file_size = os.path.getsize('network_data_sql.json')
        print(f"\nSuccessfully wrote {file_size / (1024*1024):.2f} MB of JSON data")
        
        # Upload to database as single JSON structure
        upload_to_database(network_data)
        
    except Exception as e:
        print(f"Error in process: {str(e)}")
        raise

if __name__ == "__main__":
    main()

# bills_path = r'Data\congressional_data\bills.csv'
# legislators_path = r'Data\congressional_data\legislators.csv'
# bill_sponsors_path = r'Data\congressional_data\bill_sponsors.csv'